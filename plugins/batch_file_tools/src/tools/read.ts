import type { ReadInput, ReadOutput } from "../types.js";

export async function handleBatchRead(input: ReadInput): Promise<ReadOutput> {
  return {
    results: input.requests.map((req) => ({
      path: req.path,
      mode_applied: req.mode,
      lines: 0,
      returned_lines: 0,
      truncated: false,
      error: {
        reason: "not_implemented",
        message: "batch_read not implemented yet",
      },
    })),
  };
}
