import type { ReadOutput, ReadResult } from "../types.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export function formatReadContent(result: ReadOutput): TextBlock[] {
  return result.results.map(readResultToBlock);
}

function readResultToBlock(r: ReadResult): TextBlock {
  let hint = '';
  if (r.error) {
    hint = `<!--- '${r.error.reason}' error reading file '${r.path}' as '${r.mode_applied}': ${r.error.message} --->`;
  }else{
    hint = `<!--- Read ${(r.returned_lines !== r.lines ? r.returned_lines + ' of ' : '')}${r.lines}${r.returned_lines === 1 ? ' line' : ' lines'} in file ${r.path} as '${r.mode_applied}' --->`
  }
  return { type: "text", text: `${hint}\n${r.content ?? ""}` };
}