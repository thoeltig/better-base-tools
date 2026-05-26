import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { readFileUtf8, isPathAllowed, realpathOfNearestExisting } from "../lib/fs.js";
import { expandToFiles, needsExpansion } from "../lib/glob.js";
import { formatForRead } from "../lib/transforms.js";
import { extractRefs } from "../lib/extract-refs.js";
import type { ReadInput, ReadMode, ReadOutput, ReadRequest, ReadResult, Reason } from "../types.js";

type PlanEntry = { kind: "ok"; req: ReadRequest } | { kind: "err"; result: ReadResult };

export async function handleBatchRead(
  input: ReadInput,
  allowedDirectories: string[],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<ReadOutput> {
  const expanded = await expandReadRequests(input.requests, allowedDirectories);
  const plan = await deduplicateEntries(expanded);
  const total = plan.length;
  let done = 0;
  const results = await Promise.all(
    plan.map(async entry => {
      const result = entry.kind === "err" ? entry.result : await readOne(entry.req, allowedDirectories);
      await onProgress?.(++done, total);
      return result;
    })
  );
  return { results };
}

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function deduplicateEntries(entries: PlanEntry[]): Promise<PlanEntry[]> {
  await Promise.all(
    entries.map(async entry => {
      if (entry.kind === "ok") entry.req.path = await safeRealpath(entry.req.path);
    })
  );

  const result: PlanEntry[] = [];
  const pathOrder: string[] = [];
  const byPath = new Map<string, ReadRequest[]>();

  for (const entry of entries) {
    if (entry.kind === "err") {
      result.push(entry);
      continue;
    }
    if (!byPath.has(entry.req.path)) {
      pathOrder.push(entry.req.path);
      byPath.set(entry.req.path, []);
    }
    byPath.get(entry.req.path)!.push(entry.req);
  }

  for (const path of pathOrder) {
    result.push(...deduplicatePath(path, byPath.get(path)!));
  }

  return result;
}

function deduplicatePath(path: string, reqs: ReadRequest[]): PlanEntry[] {
  const result: PlanEntry[] = [];

  // fileinfo: collapse all to one
  if (reqs.some(r => r.mode === "fileinfo")) {
    result.push({ kind: "ok", req: { path, mode: "fileinfo" } });
  }

  // search: group by (searchTerm, count, disableNorm), coalesce mode (same→same, mixed→verbatim)
  const searchGroups = new Map<string, ReadRequest[]>();
  for (const req of reqs) {
    if (req.searchTerm === undefined) continue;
    const key = `${req.searchTerm}|${req.count ?? ""}|${req.disableNormalizedFormatting ?? ""}`;
    if (!searchGroups.has(key)) searchGroups.set(key, []);
    searchGroups.get(key)!.push(req);
  }
  for (const group of searchGroups.values()) {
    const modes = new Set(group.map(r => r.mode));
    const coalescedMode: ReadMode = modes.size === 1 ? [...modes][0]! : "verbatim";
    result.push({ kind: "ok", req: { ...group[0]!, mode: coalescedMode } });
  }

  // range/full: group by disableNorm, coalesce mode, merge overlapping ranges
  const rangeReqs = reqs.filter(r => r.mode !== "fileinfo" && r.searchTerm === undefined);
  if (rangeReqs.length === 0) return result;

  const normGroups = new Map<boolean, ReadRequest[]>();
  for (const req of rangeReqs) {
    const dn = req.disableNormalizedFormatting ?? false;
    if (!normGroups.has(dn)) normGroups.set(dn, []);
    normGroups.get(dn)!.push(req);
  }

  for (const [disableNorm, group] of normGroups) {
    const modes = new Set(group.map(r => r.mode));
    const coalescedMode: ReadMode = modes.size === 1 ? [...modes][0]! : "verbatim";

    type RangeEntry = { start: number; end: number; sources: number; originalReq: ReadRequest | undefined };
    const ranges: RangeEntry[] = group.map(req => ({
      start: req.offset ?? 1,
      end: req.count !== undefined ? (req.offset ?? 1) + req.count - 1 : Infinity,
      sources: 1,
      originalReq: req,
    }));
    ranges.sort((a, b) => a.start - b.start);

    const merged: RangeEntry[] = [];
    for (const r of ranges) {
      const last = merged.at(-1);
      if (!last || (last.end !== Infinity && r.start > last.end + 1)) {
        merged.push({ ...r });
      } else {
        last.sources += r.sources;
        last.originalReq = undefined;
        last.end = last.end === Infinity || r.end === Infinity ? Infinity : Math.max(last.end, r.end);
      }
    }

    for (const range of merged) {
      // Single source with no merging: pass through the original request unchanged
      if (range.sources === 1 && range.originalReq) {
        result.push({ kind: "ok", req: range.originalReq });
        continue;
      }
      const isFullFile = range.start === 1 && range.end === Infinity;
      const finalMode = isFullFile && coalescedMode === "verbatim_numbered" ? "verbatim" : coalescedMode;
      const req: ReadRequest = { path, mode: finalMode };
      if (range.start > 1) req.offset = range.start;
      if (range.end !== Infinity) req.count = range.end - range.start + 1;
      if (disableNorm) req.disableNormalizedFormatting = true;
      result.push({ kind: "ok", req });
    }
  }

  return result;
}

async function expandReadRequests(
  requests: readonly ReadRequest[],
  allowedDirs: readonly string[],
): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = [];

  for (const req of requests) {
    req.path = resolve(req.path);
    if (!(await needsExpansion(req.path))) {
      entries.push({ kind: "ok", req });
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
  // fileinfo / fileinfo_refs: stat without full content processing
  if (req.mode === "fileinfo") {
    if (!isAbsolute(req.path)) req.path = resolve(req.path);
    try {
      const authPath = await realpathOfNearestExisting(resolve(req.path));
      if (!isPathAllowed(authPath, allowedDirectories)) {
        return errResult(req, "not_authorized", `Access denied: ${req.path}`);
      }
      const resolved = await realpath(req.path);
      const s = await stat(resolved);
      const raw = s.isFile() ? await readFile(resolved, "utf8") : "";
      const lineCount = raw.length === 0 ? 0 : raw.split(/\r?\n/).length - (raw.endsWith("\n") || raw.endsWith("\r") ? 1 : 0);
      const baseInfo = { size: s.size, lines: lineCount, mtime: new Date(s.mtimeMs).toISOString(), isFile: s.isFile() };
      const fileDir = dirname(resolved);
      const refs = extractRefs(raw).map(ref => {
        const abs = resolve(fileDir, ref);
        const rel = relative(process.cwd(), abs);
        return rel.startsWith("..") || isAbsolute(rel) ? abs : rel;
      });
      const info = refs.length > 0 ? { ...baseInfo, refs } : baseInfo;
      return {
        path: req.path,
        mode_applied: req.mode,
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
      const formatted = formatForRead({ content: file.content, mode: req.mode, path: req.path, offset: s + 1, limit: e - s + 1, ...(req.disableNormalizedFormatting ? { disableNormalizedFormatting: true } : {}) });
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
    ...(req.disableNormalizedFormatting ? { disableNormalizedFormatting: true } : {}),
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
