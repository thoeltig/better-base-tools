import type {
  EditOutput,
  FileResult,
  OpResult,
  ReadOutput,
  ReadResult,
} from "../types.js";

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
  let hint = "";
  if (r.error) {
    hint = `<!-- '${r.error.reason}' error reading file '${r.path}' as '${r.mode_applied}': ${r.error.message} -->`;
  } else if (r.mode_applied === "fileinfo") {
    hint = `<!-- File info for '${r.path}' -->`;
  } else if (r.match_count !== undefined) {
    hint = `<!-- Found ${r.match_count} match(es) in ${r.lines} lines of '${r.path}' as '${r.mode_applied}' -->`;
  } else {
    const countPrefix = r.returned_lines !== r.lines ? `${r.returned_lines} of ` : "";
    const unit = r.lines === 1 ? "line" : "lines";
    hint = `<!-- Read ${countPrefix}${r.lines} ${unit} in file '${r.path}' as '${r.mode_applied}' -->`;
  }
  return { type: "text", text: `${hint}\n${r.content ?? ""}` };
}

function editResultToBlock(r: FileResult): TextBlock {
  const headerLines: string[] = [buildFileHeader(r)];
  const bodyParts: string[] = [];

  r.ops.forEach((op, arrayIndex) => {
    const idx = op.index ?? arrayIndex;
    headerLines.push(buildOpLine(op, idx));
    const body = buildOpBody(op, idx);
    if (body !== null) bodyParts.push(body);
  });

  const header =
    headerLines.length === 1
      ? `<!-- ${headerLines[0]} -->`
      : `<!--\n${headerLines.join("\n")}\n-->`;

  if (bodyParts.length === 0) return { type: "text", text: header };
  return { type: "text", text: `${header}\n${bodyParts.join("\n")}` };
}

function buildFileHeader(r: FileResult): string {
  if(r.error) {
    return `'${r.error.reason}' error editing file '${r.path}': ${r.error.message}`;
  }
  return `Edited '${r.path}'`;
}

function buildOpLine(op: OpResult, idx: number): string {
  const tag = `- op ${idx}${op.type ? ` (${op.type})` : ""}`;
  if (op.status === "ok") {
    return op.summary ? `${tag}: ${op.summary}` : tag;
  }
  if (op.status === "skipped") return `${tag}: skipped`;
  const reason = op.reason ?? "error";
  let line = `${tag}: ${reason}`;
  const nextAction = op.hint?.next_action;
  if (nextAction) line += ` — ${nextAction}`;
  const matchLines = op.hint?.match_lines;
  if (matchLines && matchLines.length > 0) {
    line += ` (matches at lines ${matchLines.join(", ")})`;
  }
  return line;
}

function buildOpBody(op: OpResult, idx: number): string | null {
  if (op.status !== "error") return null;
  const anchor = op.hint?.nearest_anchor;
  if (!anchor) return null;
  const label = `<!-- op ${idx} nearest_anchor, lines ${anchor.start_line}-${anchor.end_line} -->`;
  const content = anchor.content.replace(/\n$/, "");
  return `${label}\n${content}`;
}
