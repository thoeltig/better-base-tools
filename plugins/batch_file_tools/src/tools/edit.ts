import { isAbsolute } from "node:path";
import { BufferLoadError, loadBuffer, writeBuffer } from "../lib/buffer.js";
import { applyOp, toOpResult } from "../lib/edit-ops.js";
import { isPathAllowed } from "../lib/fs.js";
import { expandToFiles, looksLikeGlob, needsExpansion } from "../lib/glob.js";
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
  verbose: boolean;
}

interface IndexedOp {
  readonly op: EditOp;
  readonly inputIndex: number;
}

export async function handleBatchEdit(
  input: EditInput,
  allowedDirectories: string[]
): Promise<EditOutput> {
  const results: FileResult[] = [];
  let abortRemaining = false;
  const rootStop = input.stopOnError ?? false;
  const rootVerbose = input.verbose ?? false;

  const entries = await planEntries(input.files, allowedDirectories);

  for (const entry of entries) {
    if (abortRemaining) {
      results.push(
        entry.kind === "error" ? entry.result : skipFile(entry.file, rootVerbose),
      );
      continue;
    }

    let fileResult: FileResult;
    if (entry.kind === "error") {
      fileResult = entry.result;
    } else {
      const options: FileEditOptions = {
        stopOnError: entry.file.stopOnError ?? rootStop,
        dryRun: input.dryRun,
        verbose: entry.file.verbose ?? rootVerbose,
      };
      fileResult = await editOneFile(entry.file, options, allowedDirectories);
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
    const key = dedupeKey(file.path);
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

    if (looksLikeGlob(file.path) && !isAbsolute(file.path)) {
      entries.push({
        kind: "error",
        result: buildGlobError(file, "not_absolute", `Path must be absolute: ${file.path}`),
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
      merge({ ...file, path: resolvedPath });
    }
  }

  return entries;
}

function isGlobAllowedOp(op: EditOp): boolean {
  if (op.type === "replace" || op.type === "replace_all") return true;
  if (op.type === "write" && op.mode === "append") return true;
  return false;
}

function dedupeKey(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
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

function skipFile(file: EditFile, rootVerbose: boolean): FileResult {
  const fileVerbose = file.verbose ?? rootVerbose;
  const decorated = file.ops.map((op, index) => {
    const opVerbose = resolveOpVerbose(op, fileVerbose);
    const res: OpResult = { index, status: "skipped" };
    if (opVerbose) res.type = op.type;
    return { res, opVerbose };
  });
  return {
    path: file.path,
    status: "skipped",
    ops: filterOps(decorated),
  };
}

async function editOneFile(
  file: EditFile,
  options: FileEditOptions,
  allowedDirectories: string[]
): Promise<FileResult> {
  let buf;
  try {
    buf = await loadBuffer(file.path, allowedDirectories);
  } catch (err: unknown) {
    return buildFileLoadErrorResult(file, options, err);
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

  const decoratedByIndex = new Map<number, DecoratedOp>();
  let abortedOps = false;

  for (const { op, inputIndex } of executionOrder) {
    const opVerbose = resolveOpVerbose(op, options.verbose);

    if (abortedOps) {
      decoratedByIndex.set(inputIndex, {
        res: decorateOp({ index: inputIndex, status: "skipped" }, op, opVerbose),
        opVerbose,
      });
      continue;
    }

    const overlap = overlapErrors.get(inputIndex);
    if (overlap) {
      const errRes = toOpResult(inputIndex, overlap);
      decoratedByIndex.set(inputIndex, {
        res: decorateOp(errRes, op, opVerbose),
        opVerbose,
      });
      if (op.stopOnError ?? options.stopOnError) abortedOps = true;
      continue;
    }

    const res = applyOp(buf, op);
    const opResult = toOpResult(inputIndex, res);

    decoratedByIndex.set(inputIndex, {
      res: decorateOp(opResult, op, opVerbose),
      opVerbose,
    });

    if (!res.ok && (op.stopOnError ?? options.stopOnError)) {
      abortedOps = true;
    }
  }

  const decorated: DecoratedOp[] = file.ops.map((op, i) => {
    const existing = decoratedByIndex.get(i);
    if (existing !== undefined) return existing;
    const opVerbose = resolveOpVerbose(op, options.verbose);
    return {
      res: decorateOp({ index: i, status: "skipped" }, op, opVerbose),
      opVerbose,
    };
  });
  const opResults: OpResult[] = decorated.map((d) => d.res);

  const finalContent = joinLines(buf.lines, buf.endings);
  const changed = finalContent !== originalContent || (buf.exists && !buf.existed);

  if (!options.dryRun && changed && buf.exists && !abortedOps) {
    try {
      await writeBuffer(buf);
    } catch (err: unknown) {
      return buildWriteErrorResult(file, options, opResults, err);
    }
  }

  const status = computeFileStatus(opResults);
  return {
    path: file.path,
    status,
    ops: filterOps(decorated),
  };
}

interface DecoratedOp {
  readonly res: OpResult;
  readonly opVerbose: boolean;
}

function buildFileLoadErrorResult(
  file: EditFile,
  options: FileEditOptions,
  err: unknown,
): FileResult {
  const message = err instanceof Error ? err.message : String(err);
  const fileReason: Reason = err instanceof BufferLoadError ? err.reason : "io_error";
  const decorated: DecoratedOp[] = file.ops.map((op, index) => {
    const opVerbose = resolveOpVerbose(op, options.verbose);
    const res: OpResult = {
      index,
      status: "error",
      reason: fileReason,
      hint: { next_action: message },
      type: op.type,
    };
    return { res, opVerbose };
  });
  return {
    path: file.path,
    status: "error",
    error: { reason: fileReason, message },
    ops: filterOps(decorated),
  };
}

function buildWriteErrorResult(
  file: EditFile,
  options: FileEditOptions,
  opResults: OpResult[],
  err: unknown,
): FileResult {
  const message = err instanceof Error ? err.message : String(err);
  const decorated: DecoratedOp[] = opResults.map((r, i) => {
    const op = file.ops[i]!;
    const opVerbose = resolveOpVerbose(op, options.verbose);
    const res: OpResult = {
      index: r.index,
      status: "error",
      reason: "io_error",
      hint: { next_action: `write failed: ${message}` },
      type: op.type,
    };
    return { res, opVerbose };
  });
  return {
    path: file.path,
    status: "error",
    error: { reason: "io_error", message: `write failed: ${message}` },
    ops: filterOps(decorated),
  };
}

function resolveOpVerbose(op: EditOp, fileVerbose: boolean): boolean {
  return op.verbose ?? fileVerbose;
}

function decorateOp(
  result: OpResult,
  op: EditOp,
  opVerbose: boolean,
): OpResult {
  const out = { ...result };
  if (!opVerbose) {
    if (out.status === "error") {
      out.type = op.type;
    } else {
      delete out.type;
      delete out.summary;
    }
    return out;
  }
  delete out.index;
  if (out.status === "error") {
    out.type = op.type;
  } else {
    delete out.type;
  }
  return out;
}

function filterOps(decorated: readonly DecoratedOp[]): OpResult[] {
  return decorated
    .filter((d) => d.res.status !== "ok" || d.opVerbose)
    .map((d) => d.res);
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
