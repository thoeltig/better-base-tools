import { splitLines } from "./lines.js";
import type { SplitResult } from "./lines.js";
import { formatSplitRange } from "./transforms.js";
import type { ReadRequest, ReadResult } from "../types.js";

/** Context windows closer than this many lines are merged into one block. */
const SEARCH_MERGE_GAP = 3;

/** 0-based inclusive line range. */
type LineRange = { start: number; end: number };

/**
 * Dedup key of a search request, or undefined for a plain read. Distinguishes literal
 * from regex so the same text in both fields is not merged.
 */
export function searchKey(req: ReadRequest): string | undefined {
  if (req.searchTerm !== undefined) return `term:${req.searchTerm}`;
  if (req.searchRegex !== undefined) return `regex:${req.searchRegex}`;
  return undefined;
}

/**
 * Searches one file. count=0 yields one "N:\t" unit per match ("M-N:\t" for multi-line
 * matches); count>0 yields merged context windows as "M-N:\t" blocks.
 */
export function searchFile(req: ReadRequest, content: string): ReadResult {
  const split = splitLines(content);
  const ranges = findMatchRanges(req, split, content);
  const units = req.count ? contextWindows(ranges, req.count, split.lines.length - 1) : ranges;
  const blocks = units.map(({ start, end }) => {
    const formatted = formatSplitRange(split, req.mode, req.path, start, end + 1);
    return `${lineLabel(start, end)}:\t${formatted.replace(/\r?\n$/, "")}`;
  });
  return {
    path: req.path,
    mode_applied: req.mode,
    lines: split.lines.length,
    returned_lines: units.reduce((sum, unit) => sum + unit.end - unit.start + 1, 0),
    truncated: false,
    content: blocks.join("\n"),
    match_count: ranges.length,
    ...searchFields(req),
  };
}

function searchFields(req: ReadRequest): Pick<ReadResult, "search_term" | "search_regex"> {
  if (req.searchTerm !== undefined) return { search_term: req.searchTerm };
  return req.searchRegex !== undefined ? { search_regex: req.searchRegex } : {};
}

function lineLabel(start: number, end: number): string {
  return start === end ? `${start + 1}` : `${start + 1}-${end + 1}`;
}

function findMatchRanges(req: ReadRequest, split: SplitResult, content: string): LineRange[] {
  const wholeText = wholeTextPattern(req);
  if (wholeText !== undefined) return findWholeTextRanges(wholeText, content, split.lines.length);

  const matchLine = buildLineMatcher(req);
  const ranges: LineRange[] = [];
  split.lines.forEach((line, i) => {
    if (matchLine(line)) ranges.push({ start: i, end: i });
  });
  return ranges;
}

function buildLineMatcher(req: ReadRequest): (line: string) => boolean {
  if (req.searchRegex !== undefined) {
    const re = new RegExp(req.searchRegex, "i");
    return line => re.test(line);
  }
  const needle = (req.searchTerm ?? "").toLowerCase();
  return line => line.toLowerCase().includes(needle);
}

// Searches that can only match across a line break run on the whole text (line endings
// normalized to \n); the m flag keeps ^ and $ meaning line start and end.
function wholeTextPattern(req: ReadRequest): RegExp | undefined {
  if (req.searchTerm !== undefined) {
    const term = req.searchTerm.replace(/\r\n/g, "\n");
    return term.includes("\n") ? new RegExp(escapeRegExp(term), "gi") : undefined;
  }
  if (req.searchRegex !== undefined && spansLines(req.searchRegex)) return new RegExp(req.searchRegex, "gim");
  return undefined;
}

// A literal line break or an unescaped \n escape; "\\n" is a backslash followed by n.
function spansLines(pattern: string): boolean {
  return pattern.includes("\n") || /(?:^|[^\\])(?:\\\\)*\\n/.test(pattern);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findWholeTextRanges(pattern: RegExp, content: string, lineCount: number): LineRange[] {
  if (lineCount === 0) return [];
  const text = content.replace(/\r\n/g, "\n");
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => Math.min(lastIndexAtOrBelow(lineStarts, offset), lineCount - 1);

  const ranges: LineRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const range = { start: lineOf(match.index), end: lineOf(match.index + Math.max(match[0].length, 1) - 1) };
    const last = ranges.at(-1);
    if (!last || last.start !== range.start || last.end !== range.end) ranges.push(range);
  }
  return ranges;
}

// Binary search over an ascending array: index of the last value <= target.
function lastIndexAtOrBelow(sorted: readonly number[], target: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sorted[mid]! <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}

function contextWindows(ranges: readonly LineRange[], ctx: number, lastLine: number): LineRange[] {
  const windows: LineRange[] = [];
  for (const range of ranges) {
    const start = Math.max(0, range.start - ctx);
    const end = Math.min(lastLine, range.end + ctx);
    const last = windows.at(-1);
    if (last && start - last.end - 1 <= SEARCH_MERGE_GAP) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }
  return windows;
}
