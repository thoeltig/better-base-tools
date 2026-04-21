import type { EditInput, EditOutput } from "../types.js";

export async function handleBatchEdit(input: EditInput): Promise<EditOutput> {
  return {
    results: input.files.map((file) => ({
      path: file.path,
      ops: file.ops.map((_op, index) => ({
        index,
        status: "error" as const,
        reason: "io_error" as const,
        hint: { next_action: "batch_edit not implemented yet" },
      })),
    })),
  };
}
