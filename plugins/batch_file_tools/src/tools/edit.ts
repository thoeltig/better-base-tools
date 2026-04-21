import { createPatch } from "diff";
import { loadBuffer, writeBuffer } from "../lib/buffer.js";
import { applyOp, toOpResult } from "../lib/edit-ops.js";
import { joinLines } from "../lib/lines.js";
import type {
  EditFile,
  EditInput,
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
  const opResults: OpResult[] = [];
  let abortedOps = false;

  for (let i = 0; i < file.ops.length; i++) {
    if (abortedOps) {
      opResults.push({ index: i, status: "skipped" });
      continue;
    }

    const op = file.ops[i]!;
    const before =
      options.returnDiff === "per_op" ? joinLines(buf.lines, buf.endings) : "";
    const res = applyOp(buf, op);
    const opResult = toOpResult(i, res);

    if (options.returnDiff === "per_op" && res.ok) {
      const after = joinLines(buf.lines, buf.endings);
      opResult.diff = createPatch(file.path, before, after, "", "");
    }
    opResults.push(opResult);

    if (!res.ok && !options.continueOnError) {
      abortedOps = true;
    }
  }

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
