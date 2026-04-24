import { structuredPatch } from "diff";
import { BufferLoadError, loadBuffer, writeBuffer } from "../lib/buffer.js";
import { applyOp, toOpResult } from "../lib/edit-ops.js";
import { joinLines } from "../lib/lines.js";
import type {
  EditFile,
  EditInput,
  EditOp,
  EditOutput,
  FileErrorReason,
  FileResult,
  FileStatus,
  OpResult,
  OutputMode,
} from "../types.js";

interface FileEditOptions {
  continueOnError: boolean;
  dryRun: boolean | undefined;
  rootOutput: OutputMode;
  fileOutput: OutputMode;
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

  for (const file of input.files) {
    if (abortRemaining) {
      results.push(skipFile(file, input.output));
      continue;
    }

    const options: FileEditOptions = {
      continueOnError: file.continueOnError ?? input.continueOnError,
      dryRun: input.dryRun,
      rootOutput: input.output,
      fileOutput: file.output ?? input.output,
    };
    const fileResult = await editOneFile(file, options, allowedDirectories);
    results.push(fileResult);

    if (fileResult.status !== "ok" && !input.continueOnError) {
      abortRemaining = true;
    }
  }

  return { results };
}

function skipFile(file: EditFile, rootOutput: OutputMode): FileResult {
  const fileOutput = file.output ?? rootOutput;
  const decorated = file.ops.map((op, index) => {
    const opOutput = resolveOpOutput(op, fileOutput);
    const res: OpResult = { index, status: "skipped" };
    if (opOutput !== "minimal") res.type = op.type;
    return { res, opOutput };
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
    const opOutput = resolveOpOutput(op, options.fileOutput);

    if (abortedOps) {
      decoratedByIndex.set(inputIndex, {
        res: decorateOp({ index: inputIndex, status: "skipped" }, op, opOutput),
        opOutput,
      });
      continue;
    }

    const overlap = overlapErrors.get(inputIndex);
    if (overlap) {
      const errRes = toOpResult(inputIndex, overlap);
      decoratedByIndex.set(inputIndex, {
        res: decorateOp(errRes, op, opOutput),
        opOutput,
      });
      if (!options.continueOnError) abortedOps = true;
      continue;
    }

    const before = opOutput === "diff" ? joinLines(buf.lines, buf.endings) : "";
    const res = applyOp(buf, op);
    const opResult = toOpResult(inputIndex, res);

    if (opOutput === "diff" && res.ok) {
      const after = joinLines(buf.lines, buf.endings);
      opResult.diff = diffContent(before, after);
    }
    decoratedByIndex.set(inputIndex, {
      res: decorateOp(opResult, op, opOutput),
      opOutput,
    });

    if (!res.ok && !options.continueOnError) {
      abortedOps = true;
    }
  }

  const decorated: DecoratedOp[] = file.ops.map((op, i) => {
    const existing = decoratedByIndex.get(i);
    if (existing !== undefined) return existing;
    const opOutput = resolveOpOutput(op, options.fileOutput);
    return {
      res: decorateOp({ index: i, status: "skipped" }, op, opOutput),
      opOutput,
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
  const fileResult: FileResult = {
    path: file.path,
    status,
    ops: filterOps(decorated),
  };
  if (options.fileOutput === "diff" && changed) {
    fileResult.diff = diffContent(originalContent, finalContent);
  }
  return fileResult;
}

interface DecoratedOp {
  readonly res: OpResult;
  readonly opOutput: OutputMode;
}

function buildFileLoadErrorResult(
  file: EditFile,
  options: FileEditOptions,
  err: unknown,
): FileResult {
  const message = err instanceof Error ? err.message : String(err);
  const fileReason: FileErrorReason = err instanceof BufferLoadError ? err.reason : "io_error";
  const decorated: DecoratedOp[] = file.ops.map((op, index) => {
    const opOutput = resolveOpOutput(op, options.fileOutput);
    const res: OpResult = {
      index,
      status: "error",
      reason: "io_error",
      hint: { next_action: message },
    };
    if (opOutput !== "minimal") res.type = op.type;
    return { res, opOutput };
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
    const opOutput = resolveOpOutput(op, options.fileOutput);
    const res: OpResult = {
      index: r.index,
      status: "error",
      reason: "io_error",
      hint: { next_action: `write failed: ${message}` },
    };
    if (opOutput !== "minimal") res.type = op.type;
    return { res, opOutput };
  });
  return {
    path: file.path,
    status: "error",
    error: { reason: "io_error", message: `write failed: ${message}` },
    ops: filterOps(decorated),
  };
}

function resolveOpOutput(op: EditOp, fileOutput: OutputMode): OutputMode {
  if (op.output !== undefined) return op.output;
  // File-level diff carries the whole-file change already; per-op default
  // collapses to minimal so successful ops don't duplicate the diff info.
  if (fileOutput === "diff") return "minimal";
  return fileOutput;
}

function decorateOp(
  result: OpResult,
  op: EditOp,
  opOutput: OutputMode,
): OpResult {
  const out = { ...result };
  if (opOutput === "minimal") {
    // Errored ops keep type so the model can correlate without summaries.
    if (out.status === "error") {
      out.type = op.type;
    } else {
      delete out.type;
      delete out.summary;
      delete out.diff;
    }
    return out;
  }
  // summary / diff: ops array is dense + input-ordered, so positional index
  // is redundant — drop it. Keep type.
  delete out.index;
  out.type = op.type;
  if (opOutput === "summary") {
    delete out.diff;
  } else {
    // diff mode: drop summary string (diff carries the change info).
    delete out.summary;
  }
  return out;
}

function filterOps(decorated: readonly DecoratedOp[]): OpResult[] {
  // Include if the op had any failure OR its effective per-op mode is not minimal.
  return decorated
    .filter((d) => d.res.status !== "ok" || d.opOutput !== "minimal")
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

function diffContent(oldContent: string, newContent: string): string {
  const { hunks } = structuredPatch("", "", oldContent, newContent, "", "", { context: 3 });
  if (hunks.length === 0) return "";
  const body = hunks
    .map((h) => {
      const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
      return [header, ...h.lines].join("\n");
    })
    .join("\n");
  return body + "\n";
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
