import type { ReadMode } from "../types.js";
import { splitLines } from "./lines.js";
import { basename, extname } from "node:path";

export interface FormatInput {
  readonly content: string;
  readonly mode: ReadMode;
  readonly path?: string;
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

  let content: string;
  let emittedLines = returnedLines;
  if (input.mode === "edit") {
    content = formatEdit(split.lines, clampedStart, clampedEnd);
  } else if (input.mode === "info_compact") {
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
 * Compact for informational reading. Lossy — if byte-exact output matters, use info_verbatim.
 *   1. JSON minify (.json files only, whole-slice): pretty -> compact; falls through on parse error.
 *   2. Strip trailing whitespace on each line.
 *   3. Strip leading whitespace on each line — skipped on indent-sensitive languages (Python, YAML, Haskell, F#, Nim, CoffeeScript, Pug, Sass, Makefile).
 *   4. Collapse internal runs of 2+ spaces/tabs to a single space.
 *   5. Collapse runs of 2+ blank lines to a single blank line.
 * Known limitations (no parser, so not detected):
 *   - Multi-line strings / template literals — internal whitespace is content, gets collapsed.
 *   - Fenced code blocks in Markdown may contain indent-sensitive code that gets dedented.
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

  let out = "";
  let count = 0;
  let prevBlank = false;
  for (let i = start; i < end; i++) {
    let line = lines[i] ?? "";
    line = line.replace(/[ \t]+$/, "");
    if (opts.stripIndent) {
      line = line.replace(/^[ \t]+/, "");
    }
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
