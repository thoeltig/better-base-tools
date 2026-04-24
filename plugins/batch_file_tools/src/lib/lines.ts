/**
 * Byte-exact line splitting preserving \r\n vs \n.
 *
 * Each line is stored WITHOUT its ending; `endings[i]` holds the ending
 * that terminated `lines[i]` ("" if the last line had no trailing newline).
 * This lets joinLines round-trip byte-exactly.
 */
export interface SplitResult {
  readonly lines: readonly string[];
  readonly endings: readonly string[];
  readonly dominantEnding: LineEnding; 
}

export type LineEnding = "\n" | "\r\n";

export function splitLines(content: string): SplitResult {
  const lines: string[] = [];
  const endings: string[] = [];
  let start = 0; 
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "\n") continue;
    const hasCr = i > 0 && content[i - 1] === "\r";
    lines.push(content.slice(start, hasCr ? i - 1 : i));
    
    if (hasCr) {
      crlf++;
      endings.push("\r\n");
    }
    else {
      lf++;
      endings.push("\n");
    }
    start = i + 1;
  }
  if (start < content.length) {
    lines.push(content.slice(start));
    endings.push("");
  }
  return { lines, endings, dominantEnding: crlf > lf ? "\r\n" : "\n" };
}

export function joinLines(
  lines: readonly string[],
  endings: readonly string[],
): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    out += lines[i];
    out += endings[i] ?? "";
  }
  return out;
}

function normalizeToLF(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * Convert all line endings in `s` to `target`. Standalone \r (legacy Mac)
 * is left alone — we only normalize the \r\n pair vs \n.
 */
export function convertNewlines(s: string, target: LineEnding): string {
  const lf = normalizeToLF(s);
  return target === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

export interface NormalizedMatch {
  readonly start: number;
  readonly end: number;
}

/**
 * Find every occurrence of `needle` in `content`, treating \r\n and \n as
 * equivalent. Returned spans are ORIGINAL byte offsets in `content`, so callers
 * can splice without disturbing unrelated regions of mixed-ending files.
 *
 * Empty needle returns no matches.
 */
export function findAllNormalized(content: string, needle: string): NormalizedMatch[] {
  const lfNeedle = normalizeToLF(needle);
  if (lfNeedle.length === 0) return [];

  const lfContent = normalizeToLF(content);
  const lfToOrig = buildLfToOrigMap(content, lfContent.length);

  const out: NormalizedMatch[] = [];
  let from = 0;
  while (true) {
    const lfHit = lfContent.indexOf(lfNeedle, from);
    if (lfHit === -1) break;
    out.push({
      start: lfToOrig[lfHit]!,
      end: lfToOrig[lfHit + lfNeedle.length]!,
    });
    from = lfHit + lfNeedle.length;
  }
  return out;
}

function buildLfToOrigMap(content: string, lfLength: number): Int32Array {
  const map = new Int32Array(lfLength + 1);
  let orig = 0;
  for (let lf = 0; lf <= lfLength; lf++) {
    map[lf] = orig;
    if (lf === lfLength) break;
    if (content[orig] === "\r" && content[orig + 1] === "\n") {
      orig += 2;
    } else {
      orig += 1;
    }
  }
  return map;
}
