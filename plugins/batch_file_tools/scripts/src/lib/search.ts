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
 * its matches by its own count. Every output line carries its source position: verbatim prints
 * each shown line as "N:\t", compact collapses each run of consecutive lines into one
 * "M-N:\t" line.
 */
export function searchFile(target: ReadRequest, searches: readonly ReadRequest[], content: string): ReadResult {
  const split = splitLines(content);
  const perSearch = searches.map(search => findMatchRanges(search, split, content));
  const shownLines = collectShownLines(searches, perSearch, split.lines.length);
  const outputLines = target.mode === "verbatim"
    ? shownLines.map(line => `${line + 1}:\t${split.lines[line]}`)
    : contiguousRuns(shownLines).flatMap(run => formatCompactRun(split, target.path, run));
  return {
    path: target.path,
    mode_applied: target.mode,
    lines: split.lines.length,
    returned_lines: shownLines.length,
    truncated: false,
    content: outputLines.join("\n"),
    match_count: uniqueSortedRanges(perSearch.flat()).length,
    searches: searches.map((search, i) => ({ ...searchFields(search), match_count: perSearch[i]!.length })),
  };
}

// Matched lines widened by each search's own count; ascending, each line once.
function collectShownLines(searches: readonly ReadRequest[], perSearch: readonly LineRange[][], lineCount: number): number[] {
  const shown = new Uint8Array(lineCount);
  perSearch.forEach((ranges, i) => {
    const ctx = searches[i]!.count ?? 0;
    for (const { start, end } of ranges) {
      for (let line = Math.max(0, start - ctx); line <= Math.min(lineCount - 1, end + ctx); line++) shown[line] = 1;
    }
  });
  const lines: number[] = [];
  shown.forEach((flag, line) => {
    if (flag) lines.push(line);
  });
  return lines;
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
function formatCompactRun(split: SplitResult, path: string, run: LineRange): string[] {
  const formatted = formatSplitRange(split, "compact", path, run.start, run.end + 1).replace(/\r?\n$/, "");
  if (!formatted.includes("\n")) return [`${lineLabel(run.start, run.end)}:\t${formatted}`];
  const lines: string[] = [];
  for (let line = run.start; line <= run.end; line++) {
    lines.push(`${line + 1}:\t${formatSplitRange(split, "compact", path, line, line + 1).replace(/\r?\n$/, "")}`);
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

