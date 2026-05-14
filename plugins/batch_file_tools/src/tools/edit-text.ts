import { handleBatchEdit } from "./edit.js";
import {
  parseEditText,
  type OpSlot,
  type ParsedEditFile,
  type ParseEntry,
  type ParseError,
} from "../lib/edit-text-parser.js";
import type {
  EditFile,
  EditInput,
  EditOutput,
  EditTextInput,
  FileResult,
  FileStatus,
  OpResult,
} from "../types.js";

export async function handleBatchEditText(
  input: EditTextInput,
  allowedDirectories: string[],
): Promise<EditOutput> {
  const parsed = parseEditText(input.content);

  if (parsed.rootError) {
    return { results: [makeRootErrorResult(parsed.rootError)] };
  }
  if (parsed.entries.length === 0) {
    return {
      results: [makeRootErrorResult({ line: 1, message: "no File: blocks found" })],
    };
  }

  const rootStop = parsed.stopOnError ?? false;
  const parseAbortIdx = computeParseAbortIdx(parsed.entries, rootStop);

  const handlerFiles: EditFile[] = [];
  const handlerEntryAtIdx: number[] = [];
  for (let i = 0; i < parseAbortIdx; i++) {
    const entry = parsed.entries[i]!;
    if (entry.kind === "ok" && entry.parsed.file.ops.length > 0) {
      handlerFiles.push(entry.parsed.file);
      handlerEntryAtIdx.push(i);
    }
  }

  let handlerOutput: EditOutput | undefined;
  if (handlerFiles.length > 0) {
    const handlerInput: EditInput = {
      ...(parsed.stopOnError !== undefined ? { stopOnError: parsed.stopOnError } : {}),
      ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
      files: handlerFiles,
    };
    handlerOutput = await handleBatchEdit(handlerInput, allowedDirectories);
  }

  const results: FileResult[] = [];
  let handlerIdx = 0;

  for (let i = 0; i < parsed.entries.length; i++) {
    const entry = parsed.entries[i]!;

    if (i >= parseAbortIdx) {
      results.push(makeSkippedFileResult(entry));
      continue;
    }

    if (entry.kind === "unparseable") {
      results.push(makeUnparseableFileResult(entry.path ?? "", entry.error));
      continue;
    }

    if (entry.parsed.file.ops.length === 0) {
      results.push(makeEmptyOpsFileResult(entry.parsed));
      continue;
    }

    const handlerResult = handlerOutput!.results[handlerIdx]!;
    handlerIdx++;
    results.push(mergeHandlerResult(entry.parsed, handlerResult));
  }

  return { results };
}

function computeParseAbortIdx(entries: readonly ParseEntry[], rootStop: boolean): number {
  if (!rootStop) return entries.length;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.kind === "unparseable") return i + 1;
  }
  return entries.length;
}

function makeRootErrorResult(error: ParseError): FileResult {
  return {
    path: "",
    status: "error",
    error: { reason: "unparseable", message: `line ${error.line}: ${error.message}` },
    ops: [],
  };
}

function makeUnparseableFileResult(path: string, error: ParseError): FileResult {
  return {
    path,
    status: "error",
    error: { reason: "unparseable", message: `line ${error.line}: ${error.message}` },
    ops: [],
  };
}

function makeSkippedFileResult(entry: ParseEntry): FileResult {
  const path = entry.kind === "ok" ? entry.parsed.file.path : entry.path ?? "";
  const ops: OpResult[] =
    entry.kind === "ok"
      ? entry.parsed.opSlots.map((slot, idx) => makeSlotSkippedOp(slot, idx))
      : [];
  return { path, status: "skipped", ops };
}

function makeSlotSkippedOp(slot: OpSlot, slotIdx: number): OpResult {
  if (slot.status === "unparseable") {
    return makeUnparseableOp(slot.error, slotIdx);
  }
  return { index: slotIdx, status: "skipped" };
}

function makeUnparseableOp(error: ParseError, slotIdx: number): OpResult {
  return {
    index: slotIdx,
    status: "error",
    reason: "unparseable",
    hint: { next_action: `line ${error.line}: ${error.message}` },
  };
}

function makeEmptyOpsFileResult(parsed: ParsedEditFile): FileResult {
  const ops: OpResult[] = parsed.opSlots.map((slot, idx) =>
    slot.status === "unparseable"
      ? makeUnparseableOp(slot.error, idx)
      : { index: idx, status: "ok" as const },
  );
  const hasError = ops.some((o) => o.status === "error");
  return {
    path: parsed.file.path,
    status: hasError ? "error" : "ok",
    ops,
  };
}

function mergeHandlerResult(parsed: ParsedEditFile, handlerResult: FileResult): FileResult {
  const merged: OpResult[] = [];
  let handlerPtr = 0;
  let inputIdx = 0;
  const handlerOps = handlerResult.ops;

  for (let s = 0; s < parsed.opSlots.length; s++) {
    const slot = parsed.opSlots[s]!;
    if (slot.status === "unparseable") {
      merged.push(makeUnparseableOp(slot.error, s));
      continue;
    }

    const myInputIdx = inputIdx;
    inputIdx++;

    if (handlerPtr >= handlerOps.length) continue;

    const op = handlerOps[handlerPtr]!;
    if (op.index === undefined) {
      merged.push(op);
      handlerPtr++;
      continue;
    }
    if (op.index === myInputIdx) {
      merged.push({ ...op, index: s });
      handlerPtr++;
      continue;
    }
    if (op.index < myInputIdx) {
      handlerPtr++;
      s--;
      inputIdx--;
      continue;
    }
  }

  while (handlerPtr < handlerOps.length) {
    merged.push(handlerOps[handlerPtr]!);
    handlerPtr++;
  }

  const status = computeMergedStatus(parsed.opSlots, handlerResult);
  const result: FileResult = {
    path: handlerResult.path,
    status,
    ops: merged,
  };
  if (handlerResult.error !== undefined) {
    result.error = handlerResult.error;
  }
  return result;
}

function computeMergedStatus(opSlots: readonly OpSlot[], handlerResult: FileResult): FileStatus {
  if (handlerResult.status === "error" && handlerResult.error !== undefined) {
    return "error";
  }
  const hasUnparseable = opSlots.some((s) => s.status === "unparseable");
  const handlerStatus = handlerResult.status;
  if (!hasUnparseable) return handlerStatus;
  if (handlerStatus === "ok") return "partial";
  if (handlerStatus === "partial") return "partial";
  if (handlerStatus === "skipped") return "partial";
  return "error";
}
