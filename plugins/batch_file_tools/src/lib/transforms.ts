import type { ReadMode } from "../types.js";
import { splitLines } from "./lines.js";

export interface FormatInput {
  readonly content: string;
  readonly mode: ReadMode;
  readonly offset?: number;
  readonly limit?: number;
}

export interface FormatOutput {
  readonly content: string;
  readonly total_lines: number;
  readonly returned_lines: number;
  readonly truncated: boolean;
  readonly mode_applied: ReadMode;
}

/**
 * Select a slice of lines from the file per offset/limit,
 * then format according to mode.
 *
 * Line numbers shown in `edit` mode are the source file's 1-indexed line numbers,
 * not slice-relative. Format: `{n}\t{content}\n` (unpadded — saves tokens vs cat -n).
 */
export function formatForRead(input: FormatInput): FormatOutput {
  const split = splitLines(input.content);
  const totalLines = split.lines.length;

  const startIdx = input.offset ? input.offset - 1 : 0;
  const endIdx =
    input.limit !== undefined
      ? Math.min(startIdx + input.limit, totalLines)
      : totalLines;

  const clampedStart = Math.max(0, Math.min(startIdx, totalLines));
  const clampedEnd = Math.max(clampedStart, Math.min(endIdx, totalLines));
  const returnedLines = clampedEnd - clampedStart;

  let content: string;
  let emittedLines = returnedLines;
  if (input.mode === "edit") {
    content = formatEdit(split.lines, clampedStart, clampedEnd);
  } else if (input.mode === "info_compact") {
    const compact = formatCompact(split.lines, split.endings, clampedStart, clampedEnd);
    content = compact.content;
    emittedLines = compact.line_count;
  } else {
    content = formatRaw(split.lines, split.endings, clampedStart, clampedEnd);
  }

  const truncated = returnedLines < totalLines - clampedStart;

  return {
    content,
    total_lines: totalLines,
    returned_lines: emittedLines,
    truncated,
    mode_applied: input.mode,
  };
}

function formatEdit(
  lines: readonly string[],
  start: number,
  end: number,
): string {
  let out = "";
  for (let i = start; i < end; i++) {
    const lineNum = i + 1;
    out += `${lineNum}\t${lines[i] ?? ""}\n`;
  }
  return out;
}

function formatRaw(
  lines: readonly string[],
  endings: readonly string[],
  start: number,
  end: number,
): string {
  let out = "";
  for (let i = start; i < end; i++) {
    out += lines[i] ?? "";
    out += endings[i] ?? "";
  }
  return out;
}

/**
 * Lossless compaction:
 *   1. Strip trailing whitespace on each line (space + tab only; \r is already excluded by splitLines).
 *   2. Collapse runs of 2+ blank lines (after stripping) to a single blank line.
 * Leading indent is preserved so code stays readable. Line endings are preserved as-is.
 */
function formatCompact(
  lines: readonly string[],
  endings: readonly string[],
  start: number,
  end: number,
): { content: string; line_count: number } {
  let out = "";
  let count = 0;
  let prevBlank = false;
  for (let i = start; i < end; i++) {
    const stripped = (lines[i] ?? "").replace(/[ \t]+$/, "");
    const isBlank = stripped === "";
    if (isBlank && prevBlank) continue;
    out += stripped;
    out += endings[i] ?? "";
    count++;
    prevBlank = isBlank;
  }
  return { content: out, line_count: count };
}
