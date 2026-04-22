import { createPatch } from "diff";
import { loadBuffer, writeBuffer } from "../lib/buffer.js";
import { applyOp, toOpResult } from "../lib/edit-ops.js";
import { joinLines } from "../lib/lines.js";
import type {
  EditFile,
  EditInput,
  EditOp,
  EditOutput,
  FileResult,
  OpResult,
  ReturnDiffMode,
} from "../types.js";

interface FileEditOptions {
  continueOnError: boolean;
  dryRun: boolean;
  returnDiff: ReturnDiffMode;
}

interface IndexedOp {
  readonly op: EditOp;
  readonly inputIndex: number;
}

export async function handleBatchEdit(input: EditInput): Promise<EditOutput> {
  const results: FileResult[] = [];
  let abortRemaining = false;

  for (const file of input.files) {
    if (abortRemaining) {
      results.push(skipFile(file));
      continue;
    }

    const options: FileEditOptions = {
      continueOnError: file.continueOnError ?? input.continueOnError,
      dryRun: input.dryRun,
      returnDiff: input.returnDiff,
    };
    const fileResult = await editOneFile(file, options);
    results.push(fileResult);

    const fileHadError = fileResult.ops.some((o) => o.status === "error");
    if (fileHadError && !input.continueOnError) {
      abortRemaining = true;
    }
  }

  return { results };
}

function skipFile(file: EditFile): FileResult {
  return {
    path: file.path,
    ops: file.ops.map((_op, index) => ({ index, status: "skipped" as const })),
  };
}

async function editOneFile(
  file: EditFile,
  options: FileEditOptions,
): Promise<FileResult> {
  let buf;
  try {
    buf = await loadBuffer(file.path);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      path: file.path,
      ops: file.ops.map((_op, index) => ({
        index,
        status: "error" as const,
        reason: "io_error" as const,
        hint: { next_action: message },
      })),
    };
  }

  const originalContent = joinLines(buf.lines, buf.endings);

  const indexed: IndexedOp[] = file.ops.map((op, inputIndex) => ({ op, inputIndex }));
  const phase1 = indexed.filter((x) => isPhase1(x.op));
  const phase2Create = indexed.filter((x) => x.op.type === "create");
  const phase2Other = indexed.filter(
    (x) => !isPhase1(x.op) && x.op.type !== "create",
  );

  const overlapErrors = detectPhase1Overlaps(phase1);

  const sortedPhase1 = [...phase1].sort(
    (a, b) => anchorLine(b.op) - anchorLine(a.op),
  );
  const executionOrder: IndexedOp[] = [
    ...sortedPhase1,
    ...phase2Create,
    ...phase2Other,
  ];

  const opResultsByIndex = new Map<number, OpResult>();
  const opDiffBefore = new Map<number, string>();
  let abortedOps = false;

  for (const { op, inputIndex } of executionOrder) {
    if (abortedOps) {
      opResultsByIndex.set(inputIndex, { index: inputIndex, status: "skipped" });
      continue;
    }

    const overlap = overlapErrors.get(inputIndex);
    if (overlap) {
      opResultsByIndex.set(inputIndex, toOpResult(inputIndex, overlap));
      if (!options.continueOnError) abortedOps = true;
      continue;
    }

    const before =
      options.returnDiff === "per_op" ? joinLines(buf.lines, buf.endings) : "";
    const res = applyOp(buf, op);
    const opResult = toOpResult(inputIndex, res);

    if (options.returnDiff === "per_op" && res.ok) {
      opDiffBefore.set(inputIndex, before);
      const after = joinLines(buf.lines, buf.endings);
      opResult.diff = createPatch(file.path, before, after, "", "");
    }
    opResultsByIndex.set(inputIndex, opResult);

    if (!res.ok && !options.continueOnError) {
      abortedOps = true;
    }
  }

  const opResults: OpResult[] = file.ops.map(
    (_op, i) => opResultsByIndex.get(i) ?? { index: i, status: "skipped" },
  );

  const finalContent = joinLines(buf.lines, buf.endings);
  const changed = finalContent !== originalContent || (buf.exists && !buf.existed);

  if (!options.dryRun && changed && buf.exists && !abortedOps) {
    try {
      await writeBuffer(file.path, buf);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        path: file.path,
        ops: opResults.map((r) => ({
          ...r,
          status: "error" as const,
          reason: "io_error" as const,
          hint: { next_action: `write failed: ${message}` },
        })),
      };
    }
  }

  const fileResult: FileResult = { path: file.path, ops: opResults };
  if (options.returnDiff === "per_file") {
    fileResult.diff = createPatch(file.path, originalContent, finalContent, "", "");
  }
  return fileResult;
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
  // Two inserts at the same anchor are ambiguous.
  if (a.isInsert && b.isInsert) return a.start === b.start;
  // Insert at L vs range [s,e]: conflict when s <= L <= e.
  if (a.isInsert) return a.start >= b.start && a.start <= b.end;
  if (b.isInsert) return b.start >= a.start && b.start <= a.end;
  // Two ranges: standard interval intersection.
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
