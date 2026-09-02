import { resolve } from "node:path";
import { readFileUtf8, isAccessible, safeRealpath } from "../lib/fs.js";
import type { ReadFileResult, ReadFileError } from "../lib/fs.js";
import { expandToFiles, needsExpansion } from "../lib/glob.js";
import { formatForRead } from "../lib/transforms.js";
import type { ReadInput, ReadMode, ReadOutput, ReadRequest, ReadResult, Reason } from "../types.js";

const SEARCH_MERGE_GAP = 3;

type PlanEntry = { kind: "ok"; req: ReadRequest } | { kind: "err"; result: ReadResult };

export async function handleBatchRead(
  input: ReadInput,
  allowedDirectories: string[],
  excludedPaths: readonly string[] = [],
  approvedPaths: readonly string[] = [],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<ReadOutput> {
  const expanded = await expandReadRequests(input.requests, allowedDirectories, excludedPaths, approvedPaths);
  const plan = deduplicateEntries(expanded);
  const fileCache = await buildFileCache(plan, allowedDirectories, excludedPaths, approvedPaths);
  const total = plan.length;
  let done = 0;
  const results = await Promise.all(
    plan.map(async entry => {
      const result = entry.kind === "err" ? entry.result : await readOne(entry.req, allowedDirectories, fileCache, excludedPaths, approvedPaths);
      await onProgress?.(++done, total);
      return result;
    })
  );
  return { results };
}

type FileCache = Map<string, ReadFileResult | ReadFileError>;

async function buildFileCache(plan: PlanEntry[], allowedDirectories: string[], excludedPaths: readonly string[], approvedPaths: readonly string[]): Promise<FileCache> {
  const paths = new Set<string>();
  for (const entry of plan) {
    if (entry.kind === "ok" && isAccessible(entry.req.path, allowedDirectories, excludedPaths, approvedPaths)) paths.add(entry.req.path);
  }
  const cache: FileCache = new Map();
  await Promise.all(
    [...paths].map(async p => { cache.set(p, await readFileUtf8(p, allowedDirectories)); })
  );
  return cache;
}

function deduplicateEntries(entries: PlanEntry[]): PlanEntry[] {
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

  // search: group by (searchTerm, count), coalesce mode (same→same, mixed→verbatim)
  const searchGroups = new Map<string, ReadRequest[]>();
  for (const req of reqs) {
    if (req.searchTerm === undefined) continue;
    const key = `${req.searchTerm}|${req.count ?? ""}`;
    if (!searchGroups.has(key)) searchGroups.set(key, []);
    searchGroups.get(key)!.push(req);
  }
  for (const group of searchGroups.values()) {
    const modes = new Set(group.map(r => r.mode));
    const coalescedMode: ReadMode = modes.size === 1 ? [...modes][0]! : "verbatim";
    result.push({ kind: "ok", req: { ...group[0]!, mode: coalescedMode } });
  }

  // range/full: coalesce mode, merge overlapping ranges
  const rangeReqs = reqs.filter(r => r.searchTerm === undefined);
  if (rangeReqs.length === 0) return result;

  const modes = new Set(rangeReqs.map(r => r.mode));
  const coalescedMode: ReadMode = modes.size === 1 ? [...modes][0]! : "verbatim";

  type RangeEntry = { start: number; end: number; sources: number; originalReq: ReadRequest | undefined };
  const ranges: RangeEntry[] = rangeReqs.map(req => ({
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
    const finalMode = coalescedMode;
    const req: ReadRequest = { path, mode: finalMode };
    if (range.start > 1) req.offset = range.start;
    if (range.end !== Infinity) req.count = range.end - range.start + 1;
    result.push({ kind: "ok", req });
  }

  return result;
}

async function expandReadRequests(
  requests: readonly ReadRequest[],
  allowedDirs: readonly string[],
  excludedPaths: readonly string[],
  approvedPaths: readonly string[],
): Promise<PlanEntry[]> {
  const entries: PlanEntry[] = [];

  for (const req of requests) {
    req.path = await safeRealpath(resolve(req.path));
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

    const allowed = candidates.filter(p => isAccessible(p, allowedDirs, excludedPaths, approvedPaths));
    if (allowed.length === 0) {
      entries.push({ kind: "err", result: errResult(req, "not_authorized", "no matched files are within allowed directories") });
      continue;
    }

    for (const resolvedPath of allowed) {
      entries.push({ kind: "ok", req: { ...req, path: await safeRealpath(resolvedPath) } });
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

async function readOne(req: ReadRequest, allowedDirectories: string[], fileCache: FileCache, excludedPaths: readonly string[], approvedPaths: readonly string[]): Promise<ReadResult> {
  if (!isAccessible(req.path, allowedDirectories, excludedPaths, approvedPaths)) {
    return errResult(req, 'not_authorized', `Access denied: ${req.path}`);
  }
  const file = fileCache.get(req.path) ?? await readFileUtf8(req.path, allowedDirectories);
  if (!file.ok) {
    return errResult(req, file.reason, file.message);
  }

  // search: grep with context lines
  if (req.searchTerm !== undefined) {
    const rawLines = file.content.replace(/\r\n/g, "\n").split("\n");
    if (rawLines[rawLines.length - 1] === "") rawLines.pop();

    const ctx = req.count ?? 0;
    let matchLine: (line: string) => boolean;
    try {
      const re = new RegExp(req.searchTerm, "i");
      matchLine = line => re.test(line);
    } catch {
      const needle = req.searchTerm.toLowerCase();
      matchLine = line => line.toLowerCase().includes(needle);
    }
    const matchIdxs: number[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      if (matchLine(rawLines[i] ?? "")) matchIdxs.push(i);
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
    if (ctx === 0) {
      for (const idx of matchIdxs) {
        const formatted = formatForRead({ content: file.content, mode: req.mode, path: req.path, offset: idx + 1, limit: 1 });
        blocks.push(`${idx + 1}\t${formatted.content.replace(/\r?\n$/, "")}`);
        returnedLines += 1;
      }
    } else {
      type MatchBlock = { s: number; e: number; matchLines: number[] };
      const intervals: MatchBlock[] = [];
      for (const idx of matchIdxs) {
        const s = Math.max(0, idx - ctx);
        const e = Math.min(rawLines.length - 1, idx + ctx);
        const last = intervals.at(-1);
        if (last && s - last.e - 1 <= SEARCH_MERGE_GAP) {
          last.e = Math.max(last.e, e);
          last.matchLines.push(idx);
        } else {
          intervals.push({ s, e, matchLines: [idx] });
        }
      }
      for (const { s, e, matchLines } of intervals) {
        returnedLines += e - s + 1;
        const formatted = formatForRead({ content: file.content, mode: req.mode, path: req.path, offset: s + 1, limit: e - s + 1 });
        const matchSuffix = matchLines.length === 1 ? `, match at line ${matchLines[0]! + 1}` : "";
        blocks.push(`<!-- Line ${s + 1} to ${e + 1}${matchSuffix} -->\n${formatted.content}`);
      }
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
    start_line: req.offset ?? 1,
  };
}
