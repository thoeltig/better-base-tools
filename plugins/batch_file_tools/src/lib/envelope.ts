import type { EditOutput, FileResult, ReadOutput, ReadResult } from "../types.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export function formatReadContent(result: ReadOutput): TextBlock[] {
  return result.results.map(readResultToBlock);
}

export function formatEditContent(result: EditOutput): TextBlock[] {
  return result.results.map(editResultToBlock);
}

function readResultToBlock(r: ReadResult): TextBlock {
  if (r.error) {
    return { type: "text", text: JSON.stringify({ path: r.path, error: r.error }) };
  }
  const meta: Record<string, unknown> = { path: r.path, lines: r.lines };
  if (r.returned_lines !== r.lines) {
    meta["returned_lines"] = r.returned_lines;
  }
  const header = JSON.stringify(meta);
  return { type: "text", text: `${header}\n${r.content ?? ""}` };
}

function editResultToBlock(r: FileResult): TextBlock {
  const { diff, ...rest } = r;
  const metaLine = JSON.stringify(rest);
  if (diff !== undefined) {
    return { type: "text", text: `${metaLine}\n${diff}` };
  }
  return { type: "text", text: metaLine };
}
