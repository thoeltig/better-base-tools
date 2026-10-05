import { splitLines } from "./lines.js";
import type { SplitResult } from "./lines.js";
import { formatSplitRange } from "./transforms.js";
import type { ReadRequest, ReadResult, SearchCount } from "../types.js";

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
 * Runs all searches bundled for one file (target supplies path and mode); each search widens
 * its matches by its own count. Output follows ripgrep's -n -C format: a line printed on its own
 * is "N:content" when matched and "N-content" when context; compact collapses each run of
 * consecutive lines into one "M..N:content" line.
 */
export function searchFile(target: ReadRequest, searches: readonly ReadRequest[], content: string): ReadResult {
  const split = splitLines(content);
  const perSearch = searches.map(search => findMatchRanges(search, split, content));
  const marks = markLines(searches, perSearch, split.lines.length);
  const labelLine: LabelLine = (line, text) => `${line + 1}${marks.matched[line] ? ":" : "-"}${text}`;
  const outputLines = target.mode === "verbatim"
    ? marks.shown.map(line => labelLine(line, split.lines[line] ?? ""))
    : contiguousRuns(marks.shown).flatMap(run => formatCompactRun(split, target.path, run, labelLine));
  return {
    path: target.path,
    mode_applied: target.mode,
    lines: split.lines.length,
    returned_lines: marks.shown.length,
    truncated: false,
    content: outputLines.join("\n"),
    match_count: uniqueSortedRanges(perSearch.flat()).length,
    searches: searches.map((search, i) => ({ ...searchFields(search), match_count: perSearch[i]!.length })),
  };
}

type LabelLine = (line: number, text: string) => string;

/** shown: matched lines widened by each search's own count, ascending; matched: 1 per matched line. */
type LineMarks = { shown: number[]; matched: Uint8Array };

function markLines(searches: readonly ReadRequest[], perSearch: readonly LineRange[][], lineCount: number): LineMarks {
  const shownFlags = new Uint8Array(lineCount);
  const matched = new Uint8Array(lineCount);
  perSearch.forEach((ranges, i) => {
    const ctx = searches[i]!.count ?? 0;
    for (const { start, end } of ranges) {
      matched.fill(1, start, end + 1);
      shownFlags.fill(1, Math.max(0, start - ctx), Math.min(lineCount, end + ctx + 1));
    }
  });
  const shown: number[] = [];
  shownFlags.forEach((flag, line) => {
    if (flag) shown.push(line);
  });
  return { shown, matched };
}

function contiguousRuns(lines: readonly number[]): LineRange[] {
  const runs: LineRange[] = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else runs.push({ start: line, end: line });
  }
  return runs;
}

// Compact keeps line breaks in indent-sensitive files; such a run is printed line by line so
// every output line still carries its own label.
function formatCompactRun(split: SplitResult, path: string, run: LineRange, labelLine: LabelLine): string[] {
  const formatted = formatSplitRange(split, "compact", path, run.start, run.end + 1).replace(/\r?\n$/, "");
  if (!formatted.includes("\n")) return [`${lineLabel(run.start, run.end)}:${formatted}`];
  const lines: string[] = [];
  for (let line = run.start; line <= run.end; line++) {
    lines.push(labelLine(line, formatSplitRange(split, "compact", path, line, line + 1).replace(/\r?\n$/, "")));
  }
  return lines;
}

// A line or range matched by several searches counts once.
function uniqueSortedRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  return sorted.filter((range, i) => i === 0 || range.start !== sorted[i - 1]!.start || range.end !== sorted[i - 1]!.end);
}

function searchFields(req: ReadRequest): Pick<SearchCount, "search_term" | "search_regex"> {
  if (req.searchTerm !== undefined) return { search_term: req.searchTerm };
  return req.searchRegex !== undefined ? { search_regex: req.searchRegex } : {};
}

function lineLabel(start: number, end: number): string {
  return start === end ? `${start + 1}` : `${start + 1}..${end + 1}`;
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
  const needle = req.searchTerm ?? "";
  return line => line.includes(needle);
}

// Searches that can only match across a line break run on the whole text (line endings
// normalized to \n); the m flag keeps ^ and $ meaning line start and end.
function wholeTextPattern(req: ReadRequest): RegExp | undefined {
  if (req.searchTerm !== undefined) {
    const term = req.searchTerm.replace(/\r\n/g, "\n");
    return term.includes("\n") ? new RegExp(escapeRegExp(term), "g") : undefined;
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

