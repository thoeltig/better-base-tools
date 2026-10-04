import { resolve } from "node:path";
import { readFileUtf8, isAccessible, safeRealpath } from "../lib/fs.js";
import type { ReadFileResult, ReadFileError } from "../lib/fs.js";
import { expandToFiles, needsExpansion } from "../lib/glob.js";
import { searchFile, searchKey } from "../lib/search.js";
import { formatForRead } from "../lib/transforms.js";
import type { ReadInput, ReadMode, ReadOutputWithSources, ReadRequest, ReadResult, Reason } from "../types.js";

// order: position in the expanded request list; dedup keeps the earliest so results follow request order.
type PlanEntry = ({ kind: "ok"; req: ReadRequest } | { kind: "err"; result: ReadResult }) & { order: number };
type OkEntry = Extract<PlanEntry, { kind: "ok" }>;

export async function handleBatchRead(
  input: ReadInput,
  allowedDirectories: string[],
  excludedPaths: readonly string[] = [],
  approvedPaths: readonly string[] = [],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<ReadOutputWithSources> {
  const expanded = await expandReadRequests(input.requests.map(normalizeCount), allowedDirectories, excludedPaths, approvedPaths);
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
  const sources = new Map<string, string>();
  for (const [path, file] of fileCache) {
    if (file.ok) sources.set(path, file.content);
  }
  return { results, sources };
}

// count=0 means "no context" for search and "no limit" for reads; both equal an unset count.
function normalizeCount(req: ReadRequest): ReadRequest {
  if (req.count !== 0) return req;
  const normalized = { ...req };
  delete normalized.count;
  return normalized;
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
  const byPath = new Map<string, OkEntry[]>();

  for (const entry of entries) {
    if (entry.kind === "err") {
      result.push(entry);
      continue;
    }
    if (!byPath.has(entry.req.path)) byPath.set(entry.req.path, []);
    byPath.get(entry.req.path)!.push(entry);
  }

  for (const [path, pathEntries] of byPath) {
    result.push(...deduplicatePath(path, pathEntries));
  }

  return result.sort((a, b) => a.order - b.order);
}

function deduplicatePath(path: string, entries: OkEntry[]): PlanEntry[] {
  const result: PlanEntry[] = [];

  // search: group by (search, count), coalesce mode (same→same, mixed→verbatim)
  const searchGroups = new Map<string, OkEntry[]>();
  for (const entry of entries) {
    const search = searchKey(entry.req);
    if (search === undefined) continue;
    const key = `${search}|${entry.req.count ?? ""}`;
    if (!searchGroups.has(key)) searchGroups.set(key, []);
    searchGroups.get(key)!.push(entry);
  }
  for (const group of searchGroups.values()) {
    const modes = new Set(group.map(e => e.req.mode));
    const coalescedMode: ReadMode = modes.size === 1 ? [...modes][0]! : "verbatim";
    result.push({ kind: "ok", req: { ...group[0]!.req, mode: coalescedMode }, order: group[0]!.order });
  }

  // range/full: coalesce mode, merge overlapping ranges
  const rangeEntries = entries.filter(e => searchKey(e.req) === undefined);
  if (rangeEntries.length === 0) return result;

  const modes = new Set(rangeEntries.map(e => e.req.mode));
  const coalescedMode: ReadMode = modes.size === 1 ? [...modes][0]! : "verbatim";

  type RangeEntry = { start: number; end: number; sources: number; order: number; originalReq: ReadRequest | undefined };
  const ranges: RangeEntry[] = rangeEntries.map(({ req, order }) => ({
    start: req.offset ?? 1,
    end: req.count !== undefined ? (req.offset ?? 1) + req.count - 1 : Infinity,
    sources: 1,
    order,
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
      last.order = Math.min(last.order, r.order);
      last.originalReq = undefined;
      last.end = last.end === Infinity || r.end === Infinity ? Infinity : Math.max(last.end, r.end);
    }
  }

  for (const range of merged) {
    // Single source with no merging: pass through the original request unchanged
    if (range.sources === 1 && range.originalReq) {
      result.push({ kind: "ok", req: range.originalReq, order: range.order });
      continue;
    }
    const req: ReadRequest = { path, mode: coalescedMode };
    if (range.start > 1) req.offset = range.start;
    if (range.end !== Infinity) req.count = range.end - range.start + 1;
    result.push({ kind: "ok", req, order: range.order });
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
    if (req.searchRegex !== undefined) {
      try {
        new RegExp(req.searchRegex, "i");
      } catch (err) {
        entries.push({ kind: "err", result: errResult(req, "unparseable", err instanceof Error ? err.message : String(err)), order: entries.length });
        continue;
      }
    }
    if (!(await needsExpansion(req.path))) {
      entries.push({ kind: "ok", req, order: entries.length });
      continue;
    }

    let candidates: string[];
    try {
      candidates = await expandToFiles(req.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entries.push({ kind: "err", result: errResult(req, "io_error", `glob expansion failed: ${msg}`), order: entries.length });
      continue;
    }

    if (candidates.length === 0) {
      entries.push({ kind: "err", result: errResult(req, "not_found", "no files matched"), order: entries.length });
      continue;
    }

    const allowed = candidates.filter(p => isAccessible(p, allowedDirs, excludedPaths, approvedPaths));
    if (allowed.length === 0) {
      entries.push({ kind: "err", result: errResult(req, "not_authorized", "no matched files are within allowed directories"), order: entries.length });
      continue;
    }

    for (const resolvedPath of allowed) {
      entries.push({ kind: "ok", req: { ...req, path: await safeRealpath(resolvedPath) }, order: entries.length });
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
    return errResult(req, 'not_authorized', "");
  }
  const file = fileCache.get(req.path) ?? await readFileUtf8(req.path, allowedDirectories);
  if (!file.ok) {
    return errResult(req, file.reason, file.message);
  }

  if (searchKey(req) !== undefined) return searchFile(req, file.content);

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
    start_line: formatted.start_line,
  };
}
