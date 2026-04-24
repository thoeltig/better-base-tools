import { convertNewlines, findAllNormalized, joinLines, splitLines } from "./lines.js";
import { buildNearestAnchor, findNearestLine } from "./similarity.js";
import type { NearestAnchorWindow } from "./similarity.js";
import type { EditBuffer } from "./buffer.js";
import type { EditOp, EditErrorReason, OpResult } from "../types.js";

export interface OpSuccess {
  ok: true;
  summary: string;
}

export interface OpFailure {
  ok: false;
  reason: EditErrorReason;
  nextAction: string;
  nearestAnchor?: NearestAnchorWindow;
  matchLines?: number[];
}

export type OpApplyResult = OpSuccess | OpFailure;

/**
 * Applies a single op against the buffer IN-PLACE and returns the outcome.
 * Pure-ish: mutates only `buf`. No I/O. No error hints beyond what's locally obvious —
 * richer hints (Levenshtein nearest_anchor) come in step 6.
 */
export function applyOp(buf: EditBuffer, op: EditOp): OpApplyResult {
  switch (op.type) {
    case "create":
      return applyCreate(buf, op.content);
    case "overwrite":
      return applyOverwrite(buf, op.content);
    case "append":
      return applyAppend(buf, op.content);
    case "insert_at_line":
      return applyInsertAtLine(buf, op.line, op.content);
    case "replace_range":
      return applyReplaceRange(buf, op.start, op.end, op.content);
    case "replace":
      return applyReplace(buf, op.old, op.new);
    case "replace_all":
      return applyReplaceAll(buf, op.old, op.new);
    case "delete":
      return applyReplace(buf, op.old, "", { summaryVerb: "deleted" });
  }
}

function applyReplace(
  buf: EditBuffer,
  oldStr: string,
  newStr: string,
  opts: { summaryVerb?: "replaced" | "deleted" } = {},
): OpApplyResult {
  if (!buf.exists) {
    return {
      ok: false,
      reason: "file_missing",
      nextAction: "target file does not exist",
    };
  }
  const content = joinLines(buf.lines, buf.endings);
  const matches = findAllNormalized(content, oldStr);

  if (matches.length === 0) {
    return buildNotFound(content, oldStr);
  }
  if (matches.length > 1) {
    const matchLines = matches.map((m) => lineOfOffset(content, m.start));
    return {
      ok: false,
      reason: "ambiguous",
      matchLines,
      nextAction: `'${preview(oldStr)}' matches ${matches.length} locations; use replace_all or narrow the anchor`,
    };
  }

  const { start, end } = matches[0]!;
  const matchLine = lineOfOffset(content, start);
  const newConverted = convertNewlines(newStr, buf.defaultEnding);
  const newContent = content.slice(0, start) + newConverted + content.slice(end);
  rewriteBuffer(buf, newContent);

  const verb = opts.summaryVerb ?? "replaced";
  if (verb === "deleted") {
    const deletedLines = countNewlines(oldStr) + 1;
    return {
      ok: true,
      summary: `deleted ${deletedLines} line${deletedLines === 1 ? "" : "s"} at line ${matchLine}`,
    };
  }
  return {
    ok: true,
    summary: `replaced 1 occurrence at line ${matchLine} (${end - start} chars → ${newConverted.length} chars)`,
  };
}

function applyReplaceAll(
  buf: EditBuffer,
  oldStr: string,
  newStr: string,
): OpApplyResult {
  if (!buf.exists) {
    return {
      ok: false,
      reason: "file_missing",
      nextAction: "target file does not exist",
    };
  }
  const content = joinLines(buf.lines, buf.endings);
  const matches = findAllNormalized(content, oldStr);

  if (matches.length === 0) {
    return buildNotFound(content, oldStr);
  }

  const matchLines = matches.map((m) => lineOfOffset(content, m.start));
  const newConverted = convertNewlines(newStr, buf.defaultEnding);
  // Splice each match in reverse so earlier offsets stay valid.
  let newContent = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i]!;
    newContent = newContent.slice(0, start) + newConverted + newContent.slice(end);
  }
  rewriteBuffer(buf, newContent);

  return {
    ok: true,
    summary: summarizeReplaceAll(matchLines),
  };
}

function buildNotFound(content: string, needle: string): OpFailure {
  const nearest = findNearestLine(content, needle);
  if (nearest === undefined) {
    return {
      ok: false,
      reason: "not_found",
      nextAction: `'${preview(needle)}' not found in file`,
    };
  }
  const anchor = buildNearestAnchor(content, nearest);
  const base: OpFailure = {
    ok: false,
    reason: "not_found",
    nextAction:
      anchor !== undefined
        ? `'${preview(needle)}' not found — nearest similar line is ${nearest}; use nearest_anchor.content as the 'old' anchor`
        : `'${preview(needle)}' not found — nearest similar line is ${nearest}; re-read a window there`,
  };
  if (anchor !== undefined) base.nearestAnchor = anchor;
  return base;
}

function rewriteBuffer(buf: EditBuffer, content: string): void {
  const split = splitLines(content);
  buf.lines = [...split.lines];
  buf.endings = [...split.endings];
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

function preview(s: string): string {
  const oneLine = s.replace(/\r?\n/g, "\\n");
  if (oneLine.length <= 40) return oneLine;
  return `${oneLine.slice(0, 37)}...`;
}

function summarizeReplaceAll(matchLines: readonly number[]): string {
  const n = matchLines.length;
  const noun = n === 1 ? "occurrence" : "occurrences";
  if (n <= 5) {
    return `replaced ${n} ${noun} (lines ${matchLines.join(", ")})`;
  }
  return `replaced ${n} ${noun} (first: line ${matchLines[0]}, last: line ${matchLines[n - 1]})`;
}

function applyCreate(buf: EditBuffer, content: string): OpApplyResult {
  if (buf.exists) {
    return {
      ok: false,
      reason: "file_exists",
      nextAction: "use 'overwrite' to replace an existing file",
    };
  }
  replaceAllContent(buf, content);
  buf.exists = true;
  const bytes = Buffer.byteLength(content, "utf8");
  return { ok: true, summary: `created file (${buf.lines.length} lines, ${bytes} bytes)` };
}

function applyOverwrite(buf: EditBuffer, content: string): OpApplyResult {
  const prevLines = buf.lines.length;
  const prevExisted = buf.exists;
  replaceAllContent(buf, content);
  buf.exists = true;
  const summary = prevExisted
    ? `overwrote file (was ${prevLines} lines, now ${buf.lines.length} lines)`
    : `created file via overwrite (${buf.lines.length} lines)`;
  return { ok: true, summary };
}

function applyAppend(buf: EditBuffer, content: string): OpApplyResult {
  if (content === "") {
    buf.exists = true;
    return { ok: true, summary: "appended 0 lines (no-op, empty content)" };
  }
  const prevEof = buf.lines.length;
  const { lines: newLines, endings: newEndings } = parseInsertContent(buf, content);
  buf.lines.push(...newLines);
  buf.endings.push(...newEndings);
  buf.exists = true;
  return {
    ok: true,
    summary: `appended ${newLines.length} line${newLines.length === 1 ? "" : "s"} (EOF was line ${prevEof})`,
  };
}

function applyInsertAtLine(
  buf: EditBuffer,
  line: number,
  content: string,
): OpApplyResult {
  if (line < 1 || line > buf.lines.length + 1) {
    return {
      ok: false,
      reason: "invalid_range",
      nextAction: `line ${line} is outside [1, ${buf.lines.length + 1}]`,
    };
  }
  if (!buf.exists) {
    return {
      ok: false,
      reason: "file_missing",
      nextAction: "use 'create' before inserting into a new file",
    };
  }
  const { lines: newLines, endings: newEndings } = parseInsertContent(buf, content);
  const idx = line - 1;
  buf.lines.splice(idx, 0, ...newLines);
  buf.endings.splice(idx, 0, ...newEndings);
  return {
    ok: true,
    summary: `inserted ${newLines.length} line${newLines.length === 1 ? "" : "s"} at line ${line}`,
  };
}

function applyReplaceRange(
  buf: EditBuffer,
  start: number,
  end: number,
  content: string,
): OpApplyResult {
  if (!buf.exists) {
    return {
      ok: false,
      reason: "file_missing",
      nextAction: "target file does not exist",
    };
  }
  if (start < 1 || end < start || end > buf.lines.length) {
    return {
      ok: false,
      reason: "invalid_range",
      nextAction: `range ${start}-${end} invalid for file with ${buf.lines.length} lines`,
    };
  }
  const deleteCount = end - start + 1;
  const { lines: newLines, endings: newEndings } = parseInsertContent(buf, content);
  buf.lines.splice(start - 1, deleteCount, ...newLines);
  buf.endings.splice(start - 1, deleteCount, ...newEndings);
  return {
    ok: true,
    summary: `replaced lines ${start}-${end} (${deleteCount} line${deleteCount === 1 ? "" : "s"} → ${newLines.length} line${newLines.length === 1 ? "" : "s"})`,
  };
}

function replaceAllContent(buf: EditBuffer, content: string): void {
  const split = splitLines(content);
  buf.lines = [...split.lines];
  buf.endings = [...split.endings];
}

/**
 * Parses content for insertion into an existing buffer:
 * - Preserves embedded line endings byte-exactly (CRLF or LF as given).
 * - If content has no trailing newline, appends the buffer's dominantEnding so
 *   the inserted block doesn't fuse with the next line.
 * - Empty content produces zero lines (caller should short-circuit).
 */
function parseInsertContent(
  buf: EditBuffer,
  content: string,
): { lines: string[]; endings: string[] } {
  // Auto-match: convert all line endings in the inserted block to the file's
  // dominant ending so a file's CRLF/LF convention is preserved regardless of
  // what the model supplied.
  const normalized = convertNewlines(content, buf.defaultEnding);
  const split = splitLines(normalized);
  const lines = [...split.lines];
  const endings = [...split.endings];
  if (lines.length > 0 && endings[endings.length - 1] === "") {
    endings[endings.length - 1] = buf.defaultEnding;
  }
  return { lines, endings };
}

export function toOpResult(index: number, res: OpApplyResult): OpResult {
  if (res.ok) {
    return { index, status: "ok", summary: res.summary };
  }
  const hint: OpResult["hint"] = { next_action: res.nextAction };
  if (res.nearestAnchor !== undefined) {
    hint.nearest_anchor = {
      start_line: res.nearestAnchor.startLine,
      end_line: res.nearestAnchor.endLine,
      content: res.nearestAnchor.content,
    };
  }
  if (res.matchLines !== undefined) hint.match_lines = res.matchLines;
  return { index, status: "error", reason: res.reason, hint };
}
