import { readFileUtf8 } from "../lib/fs.js";
import { formatForRead } from "../lib/transforms.js";
import type { ReadInput, ReadOutput, ReadRequest, ReadResult } from "../types.js";

export async function handleBatchRead(
  input: ReadInput, 
  allowedDirectories: string[]
): Promise<ReadOutput> {
  const results = await Promise.all(input.requests.map(x => readOne(x, allowedDirectories)));
  return { results };
}

async function readOne(
  req: ReadRequest, 
  allowedDirectories: string[]
): Promise<ReadResult> {  
  const file = await readFileUtf8(req.path, allowedDirectories);
  if (!file.ok) {
    return {
      path: req.path,
      mode_applied: req.mode,
      lines: 0,
      returned_lines: 0,
      truncated: false,
      content: '',
      error: { reason: file.reason, message: file.message },
    };
  }

  const formatted = formatForRead({
    content: file.content,
    mode: req.mode,
    path: req.path,
    ...(req.offset !== undefined ? { offset: req.offset } : {}),
    ...(req.limit !== undefined ? { limit: req.limit } : {}),
  });

  return {
    path: req.path,
    mode_applied: formatted.mode_applied,
    lines: formatted.total_lines,
    returned_lines: formatted.returned_lines,
    truncated: formatted.truncated,
    content: formatted.content,
  };
}
