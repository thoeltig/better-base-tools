import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { readFileUtf8, isPathAllowed } from "../lib/fs.js";
import { expandToFiles, looksLikeGlob, needsExpansion } from "../lib/glob.js";
import { formatForRead } from "../lib/transforms.js";
import type { ReadInput, ReadOutput, ReadRequest, ReadResult, Reason } from "../types.js";

type PlanEntry = { kind: "ok"; req: ReadRequest } | { kind: "err"; result: ReadResult };

export async function handleBatchRead(
  input: ReadInput,
  allowedDirectories: string[]
): Promise<ReadOutput> {
  const plan = await expandReadRequests(input.requests, allowedDirectories);
  const results = await Promise.all(
    plan.map(entry => entry.kind === "err" ? entry.result : readOne(entry.req, allowedDirectories))
  );
  return { results };
}

async function expandReadRequests(
  requests: readonly ReadRequest[],
  allowedDirs: readonly string[],
): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = [];

  for (const req of requests) {
    if (!(await needsExpansion(req.path))) {
      entries.push({ kind: "ok", req });
      continue;
    }

    if (looksLikeGlob(req.path) && !isAbsolute(req.path)) {
      entries.push({ kind: "err", result: errResult(req, "not_absolute", `Path must be absolute: ${req.path}`) });
      continue;
    }

    let candidates: string[];
    try {
      candidates = await expandToFiles(req.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entries.push({ kind: "err", result: errResult(req, "io_error", `glob expansion failed: ${msg}`) });
      continue;
    }

    if (candidates.length === 0) {
      entries.push({ kind: "err", result: errResult(req, "not_found", `no files matched: ${req.path}`) });
      continue;
    }

    const allowed = candidates.filter(p => isPathAllowed(p, allowedDirs));
    if (allowed.length === 0) {
      entries.push({ kind: "err", result: errResult(req, "not_authorized", "no matched files are within allowed directories") });
      continue;
    }

    for (const resolvedPath of allowed) {
      entries.push({ kind: "ok", req: { ...req, path: resolvedPath } });
    }
  }

  return entries;
}

function errResult(req: ReadRequest, reason: Reason, message: string): ReadResult {
  return {
    path: req.path,
    mode_applied: req.mode,
    lines: 0,
    returned_lines: 0,
    truncated: false,
    content: "",
    error: { reason, message },
  };
}

async function readOne(req: ReadRequest, allowedDirectories: string[]): Promise<ReadResult> {
  // fileinfo: stat without reading content
  if (req.mode === "fileinfo") {
    if (!isAbsolute(req.path)) {
      return errResult(req, "not_absolute", `Path must be absolute: ${req.path}`);
    }
    try {
      const resolved = await realpath(req.path);
      if (!isPathAllowed(resolved, allowedDirectories)) {
        return errResult(req, "not_authorized", `Access denied: ${req.path}`);
      }
      const s = await stat(resolved);
      const raw = s.isFile() ? await readFile(resolved, "utf8") : "";
      const lineCount = raw.length === 0 ? 0 : raw.split(/\r?\n/).length - (raw.endsWith("\n") || raw.endsWith("\r") ? 1 : 0);
      const info = { size: s.size, lines: lineCount, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, isFile: s.isFile() };
      return {
        path: req.path,
        mode_applied: "fileinfo",
        lines: lineCount,
        returned_lines: 0,
        truncated: false,
        content: JSON.stringify(info),
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const reason: Reason = e.code === "ENOENT" ? "not_found" : "io_error";
      return errResult(req, reason, e.message ?? String(err));
    }
  }

  const file = await readFileUtf8(req.path, allowedDirectories);
  if (!file.ok) {
    return errResult(req, file.reason, file.message);
  }

  // search: grep with context lines
  if (req.searchTerm !== undefined) {
    const rawLines = file.content.replace(/\r\n/g, "\n").split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();

    const needle = req.searchTerm.toLowerCase();
    const ctx = req.count ?? 0;
    const matchIdxs: number[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      if ((rawLines[i] ?? "").toLowerCase().includes(needle)) matchIdxs.push(i);
    }

    if (matchIdxs.length === 0) {
      return {
        path: req.path,
        mode_applied: req.mode,
        lines: rawLines.length,
        returned_lines: 0,
        truncated: false,
        content: "",
        match_count: 0,
      };
    }

    let returnedLines = 0;
    const blocks: string[] = [];
    for (const idx of matchIdxs) {
      const s = Math.max(0, idx - ctx);
      const e = Math.min(rawLines.length - 1, idx + ctx);
      returnedLines += e - s + 1;
      const formatted = formatForRead({ content: file.content, mode: req.mode, path: req.path, offset: s + 1, limit: e - s + 1 });
      blocks.push(`<!-- Match at line ${idx + 1} -->\n${formatted.content}`);
    }

    return {
      path: req.path,
      mode_applied: req.mode,
      lines: rawLines.length,
      returned_lines: returnedLines,
      truncated: false,
      content: blocks.join("\n"),
      match_count: matchIdxs.length,
    };
  }

  // normal read
  const formatted = formatForRead({
    content: file.content,
    mode: req.mode,
    path: req.path,
    ...(req.offset !== undefined ? { offset: req.offset } : {}),
    ...(req.count !== undefined ? { limit: req.count } : {}),
  });

  return {
    path: req.path,
    mode_applied: formatted.mode_applied,
    lines: formatted.total_lines,
    returned_lines: formatted.returned_lines,
    truncated: formatted.truncated,
    content: formatted.content,
  };
}
