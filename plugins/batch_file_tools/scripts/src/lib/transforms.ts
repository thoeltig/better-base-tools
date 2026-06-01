import type { ReadMode } from "../types.js";
import { splitLines } from "./lines.js";
import { basename, extname } from "node:path";

export interface FormatInput {
  readonly content: string;
  readonly mode: ReadMode;
  readonly path?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly normalizeFormatting?: boolean;
}

export interface FormatOutput {
  readonly content: string;
  readonly total_lines: number;
  readonly returned_lines: number;
  readonly truncated: boolean;
  readonly mode_applied: ReadMode;
}

// Languages where leading indentation carries syntactic meaning. Leading indent
// is preserved on these even in compact mode.
const INDENT_SENSITIVE_EXTS = new Set<string>([
  ".py", ".pyi", ".pyx",
  ".yaml", ".yml",
  ".hs", ".lhs",
  ".fs", ".fsi", ".fsx",
  ".nim", ".nims",
  ".coffee",
  ".pug", ".jade",
  ".sass",
]);
const INDENT_SENSITIVE_BASENAMES = new Set<string>([
  "makefile", "gnumakefile",
]);

function isIndentSensitive(path: string | undefined): boolean {
  if (path === undefined) return true;
  const ext = extname(path).toLowerCase();
  if (INDENT_SENSITIVE_EXTS.has(ext)) return true;
  const base = basename(path).toLowerCase();
  if (INDENT_SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith("makefile.")) return true;
  return false;
}

const TAB_REQUIRED_BASENAMES = new Set<string>(["makefile", "gnumakefile"]);

function isTabRequired(path: string | undefined): boolean {
  if (!path) return false;
  const base = basename(path).toLowerCase();
  return TAB_REQUIRED_BASENAMES.has(base) || base.startsWith("makefile.");
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function detectIndentUnit(lines: readonly string[]): number {
  if (lines.some(l => l.startsWith("\t"))) return 0;
  const counts = lines
    .map(l => /^( +)/.exec(l)?.[1]?.length ?? 0)
    .filter(n => n > 0);
  if (counts.length === 0) return 2;
  return counts.reduce((a, b) => gcd(a, b));
}

function normalizeLineIndent(line: string, indentUnit: number): string {
  if (indentUnit === 0) {
    const m = /^(\t+)/.exec(line);
    if (!m) return line;
    return "  ".repeat(m[1]!.length) + line.slice(m[1]!.length);
  }
  const m = /^( +)/.exec(line);
  if (!m) return line;
  const spaces = m[1]!.length;
  const levels = Math.floor(spaces / indentUnit);
  const remainder = spaces % indentUnit;
  return "  ".repeat(levels) + " ".repeat(remainder) + line.slice(spaces);
}

function isJsonPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  return extname(path).toLowerCase() === ".json";
}

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

  const disableNormalizedFormatting = input.normalizeFormatting === false;
  let content: string;
  let emittedLines = returnedLines;
  if (input.mode === "compact") {
    const compact = formatCompact(
      split.lines,
      split.endings,
      clampedStart,
      clampedEnd,
      { path: input.path, stripIndent: !isIndentSensitive(input.path) },
    );
    content = compact.content;
    emittedLines = compact.line_count;
  } else {
    content = formatRaw(split.lines, split.endings, clampedStart, clampedEnd, input.path, disableNormalizedFormatting);
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


function formatRaw(
  lines: readonly string[],
  endings: readonly string[],
  start: number,
  end: number,
  path?: string,
  disableNorm?: boolean,
): string {
  const indentUnit = (!disableNorm && !isTabRequired(path))
    ? detectIndentUnit(lines.slice(start, end))
    : -1;
  let out = "";
  for (let i = start; i < end; i++) {
    let line = lines[i] ?? "";
    if (indentUnit >= 0) line = normalizeLineIndent(line, indentUnit);
    out += line;
    out += endings[i] ?? "";
  }
  return out;
}

/**
 * Compact for informational reading. Lossy — if byte-exact output matters, use verbatim mode.
 * Non-indent-sensitive files (e.g. .ts, .js, .html): collapsed to a single line — all newlines
 *   removed, whitespace runs → single space. JSON files: minified via JSON.stringify.
 * Indent-sensitive files (Python, YAML, Makefile, etc.) and unknown paths: multi-line preserved,
 *   consecutive blank lines collapsed to one, internal whitespace runs collapsed.
 * Known limitation: string literals / template literals have internal whitespace collapsed too.
 */
function formatCompact(
  lines: readonly string[],
  endings: readonly string[],
  start: number,
  end: number,
  opts: { path: string | undefined; stripIndent: boolean },
): { content: string; line_count: number } {
  if (isJsonPath(opts.path)) {
    const raw = formatRaw(lines, endings, start, end);
    try {
      const minified = JSON.stringify(JSON.parse(raw));
      return { content: minified, line_count: 1 };
    } catch {
      // fall through to line-based compact
    }
  }

  if (opts.stripIndent) {
    // Non-indent-sensitive: collapse all lines to a single line.
    const tokens: string[] = [];
    for (let i = start; i < end; i++) {
      const line = (lines[i] ?? "").replace(/[ \t]+$/, "").replace(/^[ \t]+/, "").replace(/[ \t]{2,}/g, " ");
      if (line !== "") tokens.push(line);
    }
    const out = tokens.join(" ").replace(/ {2,}/g, " ");
    return { content: out, line_count: out.length > 0 ? 1 : 0 };
  }

  // Indent-sensitive: preserve newlines, collapse consecutive blank lines.
  let out = "";
  let count = 0;
  let prevBlank = false;
  for (let i = start; i < end; i++) {
    let line = lines[i] ?? "";
    line = line.replace(/[ \t]+$/, "");
    const leadMatch = /^[ \t]*/.exec(line);
    const lead = leadMatch ? leadMatch[0] : "";
    const rest = line.slice(lead.length).replace(/[ \t]{2,}/g, " ");
    line = lead + rest;

    const isBlank = line === "";
    if (isBlank && prevBlank) continue;
    out += line;
    out += endings[i] ?? "";
    count++;
    prevBlank = isBlank;
  }
  return { content: out, line_count: count };
}
