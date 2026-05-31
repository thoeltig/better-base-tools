import { resolve } from "node:path";
import { BufferLoadError, loadBuffer, writeBuffer } from "../lib/buffer.js";
import { applyOp, toOpResult } from "../lib/edit-ops.js";
import { isPathAllowed, safeRealpath } from "../lib/fs.js";
import { expandToFiles, needsExpansion } from "../lib/glob.js";
import { joinLines } from "../lib/lines.js";
import type {
  EditFile,
  EditInput,
  EditOp,
  EditOutput,
  Reason,
  FileResult,
  FileStatus,
  OpResult,
} from "../types.js";

interface FileEditOptions {
  stopOnError: boolean;
  dryRun: boolean | undefined;
}

interface IndexedOp {
  readonly op: EditOp;
  readonly inputIndex: number;
}

export async function handleBatchEdit(
  input: EditInput,
  allowedDirectories: string[],
  dryRun: boolean,
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<EditOutput> {
  const results: FileResult[] = [];
  let abortRemaining = false;
  const rootStop = input.stopOnError ?? false;

  const entries = await planEntries(input.files, allowedDirectories);

  const total = onProgress
    ? entries.reduce((s, e) => s + (e.kind === "process" ? e.file.ops.length : e.result.ops.length), 0)
    : 0;
  let done = 0;

  for (const entry of entries) {
    if (abortRemaining) {
      const r = entry.kind === "error" ? entry.result : skipFile(entry.file);
      results.push(r);
      if (onProgress) {
        done += r.ops.length;
        await onProgress(done, total);
      }
      continue;
    }

    let fileResult: FileResult;
    if (entry.kind === "error") {
      fileResult = entry.result;
      if (onProgress) {
        done += fileResult.ops.length;
        await onProgress(done, total);
      }
    } else {
      const options: FileEditOptions = {
        stopOnError: entry.file.stopOnError ?? rootStop,
        dryRun,
      };
      const opsBefore = done;
      const onOpDone = onProgress ? async () => { await onProgress(++done, total); } : undefined;
      fileResult = await editOneFile(entry.file, options, allowedDirectories, onOpDone);
      // If editOneFile returned early (e.g. buffer load error), catch up the counter
      if (onProgress && done - opsBefore < entry.file.ops.length) {
        done = opsBefore + entry.file.ops.length;
        await onProgress(done, total);
      }
    }
    results.push(fileResult);

    // Across-file abort uses root only — file.stopOnError scopes within-file.
    if (fileResult.status !== "ok" && rootStop) {
      abortRemaining = true;
    }
  }

  return { results };
}

type PlannedEntry =
  | { kind: "process"; file: EditFile }
  | { kind: "error"; result: FileResult };

async function planEntries(
  files: readonly EditFile[],
  allowedDirectories: readonly string[],
): Promise<PlannedEntry[]> {
  const entries: PlannedEntry[] = [];
  const byPath = new Map<string, EditFile>();

  const merge = (file: EditFile): void => {
    const key = file.path;
    const existing = byPath.get(key);
    if (existing) {
      existing.ops.push(...file.ops);
      return;
    }
    const fresh: EditFile = { ...file, ops: [...file.ops] };
    byPath.set(key, fresh);
    entries.push({ kind: "process", file: fresh });
  };

  for (const file of files) {
    file.path = await safeRealpath(resolve(file.path));
    if (!(await needsExpansion(file.path))) {
      merge(file);
      continue;
    }

    const incompatible = file.ops.find((op) => !isGlobAllowedOp(op));
    if (incompatible) {
      const opLabel =
        incompatible.type === "write" ? `write(${incompatible.mode})` : incompatible.type;
      entries.push({
        kind: "error",
        result: buildGlobError(
          file,
          "not_supported",
          `op type '${opLabel}' is not allowed with glob/folder paths; allowed: replace, replace_all, write(mode='append')`,
        ),
      });
      continue;
    }


    let candidates: string[];
    try {
      candidates = await expandToFiles(file.path);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      entries.push({
        kind: "error",
        result: buildGlobError(file, "io_error", `glob expansion failed: ${msg}`),
      });
      continue;
    }

    if (candidates.length === 0) {
      entries.push({
        kind: "error",
        result: buildGlobError(file, "not_found", `no files matched: ${file.path}`),
      });
      continue;
    }

    const allowed = candidates.filter((p) => isPathAllowed(p, allowedDirectories));
    if (allowed.length === 0) {
      entries.push({
        kind: "error",
        result: buildGlobError(
          file,
          "not_authorized",
          `no matched files are within allowed directories`,
        ),
      });
      continue;
    }

    for (const resolvedPath of allowed) {
      merge({ ...file, path: await safeRealpath(resolvedPath) });
    }
  }

  return entries;
}

function isGlobAllowedOp(op: EditOp): boolean {
  if (op.type === "replace" || op.type === "replace_all") return true;
  if (op.type === "write" && op.mode === "append") return true;
  return false;
}

function buildGlobError(file: EditFile, reason: Reason, message: string): FileResult {
  const ops: OpResult[] = file.ops.map((op, index) => ({
    index,
    status: "error",
    type: op.type,
    reason,
    hint: { next_action: message },
  }));
  return {
    path: file.path,
    status: "error",
    error: { reason, message },
    ops,
  };
}

function skipFile(file: EditFile): FileResult {
  return {
    path: file.path,
    status: "skipped",
    ops: file.ops.map((_, index): OpResult => ({ index, status: "skipped" })),
  };
}

async function editOneFile(
  file: EditFile,
  options: FileEditOptions,
  allowedDirectories: string[],
  onOpDone?: () => Promise<void>
): Promise<FileResult> {
  let buf;
  try {
    buf = await loadBuffer(file.path, allowedDirectories);
  } catch (err: unknown) {
    return buildFileLoadErrorResult(file, err);
  }

  const originalContent = joinLines(buf.lines, buf.endings);

  const indexed: IndexedOp[] = file.ops.map((op, inputIndex) => ({ op, inputIndex }));
  const phase1 = indexed.filter((x) => isPhase1(x.op));
  const phase2 = indexed.filter((x) => !isPhase1(x.op));

  const overlapErrors = detectPhase1Overlaps(phase1);

  const sortedPhase1 = [...phase1].sort(
    (a, b) => anchorLine(b.op) - anchorLine(a.op),
  );
  const executionOrder: IndexedOp[] = [...sortedPhase1, ...phase2];

  const resultsByIndex = new Map<number, OpResult>();
  let abortedOps = false;

  for (const { op, inputIndex } of executionOrder) {
    try {
      if (abortedOps) {
        resultsByIndex.set(inputIndex, decorateOp({ index: inputIndex, status: "skipped" }, op));
        continue;
      }

      const overlap = overlapErrors.get(inputIndex);
      if (overlap) {
        resultsByIndex.set(inputIndex, decorateOp(toOpResult(inputIndex, overlap), op));
        if (op.stopOnError ?? options.stopOnError) abortedOps = true;
        continue;
      }

      const res = applyOp(buf, op);
      resultsByIndex.set(inputIndex, decorateOp(toOpResult(inputIndex, res), op));

      if (!res.ok && (op.stopOnError ?? options.stopOnError)) {
        abortedOps = true;
      }
    } finally {
      await onOpDone?.();
    }
  }

  const opResults: OpResult[] = file.ops.map((op, i) => {
    const existing = resultsByIndex.get(i);
    if (existing !== undefined) return existing;
    return decorateOp({ index: i, status: "skipped" }, op);
  });

  const finalContent = joinLines(buf.lines, buf.endings);
  const changed = finalContent !== originalContent || (buf.exists && !buf.existed);

  if (!options.dryRun && changed && buf.exists && !abortedOps) {
    try {
      await writeBuffer(buf);
    } catch (err: unknown) {
      return buildWriteErrorResult(file, opResults, err);
    }
  }

  const status = computeFileStatus(opResults);
  return {
    path: file.path,
    status,
    ops: filterOps(opResults),
  };
}

function buildFileLoadErrorResult(file: EditFile, err: unknown): FileResult {
  const message = err instanceof Error ? err.message : String(err);
  const fileReason: Reason = err instanceof BufferLoadError ? err.reason : "io_error";
  return {
    path: file.path,
    status: "error",
    error: { reason: fileReason, message },
    ops: file.ops.map((op, index): OpResult => ({
      index,
      status: "error",
      reason: fileReason,
      type: op.type,
      hint: { next_action: message },
    })),
  };
}

function buildWriteErrorResult(file: EditFile, opResults: OpResult[], err: unknown): FileResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    path: file.path,
    status: "error",
    error: { reason: "io_error", message: `write failed: ${message}` },
    ops: opResults.map((r, i): OpResult => ({
      index: r.index,
      status: "error",
      reason: "io_error",
      type: file.ops[i]!.type,
      hint: { next_action: `write failed: ${message}` },
    })),
  };
}

function decorateOp(result: OpResult, op: EditOp): OpResult {
  if (result.status !== "error") return result;
  return { ...result, type: op.type };
}

function filterOps(results: readonly OpResult[]): OpResult[] {
  return results.filter(r => r.status !== "ok");
}

function computeFileStatus(ops: readonly OpResult[]): FileStatus {
  const hasError = ops.some((o) => o.status === "error");
  const hasOk = ops.some((o) => o.status === "ok");
  if (hasError && hasOk) return "partial";
  if (hasError) return "error";
  return "ok";
}

function isPhase1(op: EditOp): boolean {
  return op.type === "insert_at_line" || op.type === "replace_range";
}

function anchorLine(op: EditOp): number {
  if (op.type === "insert_at_line") return op.line;
  if (op.type === "replace_range") return op.start;
  return 0;
}

interface Phase1Range {
  readonly start: number;
  readonly end: number;
  readonly isInsert: boolean;
}

function rangeOf(op: EditOp): Phase1Range {
  if (op.type === "insert_at_line") {
    return { start: op.line, end: op.line, isInsert: true };
  }
  if (op.type === "replace_range") {
    return { start: op.start, end: op.end, isInsert: false };
  }
  throw new Error(`rangeOf called on non-phase-1 op: ${op.type}`);
}

function overlaps(a: Phase1Range, b: Phase1Range): boolean {
  if (a.isInsert && b.isInsert) return a.start === b.start;
  if (a.isInsert) return a.start >= b.start && a.start <= b.end;
  if (b.isInsert) return b.start >= a.start && b.start <= a.end;
  return Math.max(a.start, b.start) <= Math.min(a.end, b.end);
}

interface OverlapFailure {
  ok: false;
  reason: "invalid_range";
  nextAction: string;
}

function detectPhase1Overlaps(
  phase1: readonly IndexedOp[],
): Map<number, OverlapFailure> {
  const errors = new Map<number, OverlapFailure>();
  for (let i = 0; i < phase1.length; i++) {
    for (let j = i + 1; j < phase1.length; j++) {
      const a = phase1[i]!;
      const b = phase1[j]!;
      if (!overlaps(rangeOf(a.op), rangeOf(b.op))) continue;
      recordOverlap(errors, a, b);
      recordOverlap(errors, b, a);
    }
  }
  return errors;
}

function recordOverlap(
  errors: Map<number, OverlapFailure>,
  self: IndexedOp,
  other: IndexedOp,
): void {
  if (errors.has(self.inputIndex)) return;
  const desc = describeRange(other.op);
  errors.set(self.inputIndex, {
    ok: false,
    reason: "invalid_range",
    nextAction: `overlaps with op at index ${other.inputIndex} (${desc})`,
  });
}

function describeRange(op: EditOp): string {
  if (op.type === "insert_at_line") return `insert_at_line ${op.line}`;
  if (op.type === "replace_range") return `replace_range ${op.start}-${op.end}`;
  return op.type;
}
