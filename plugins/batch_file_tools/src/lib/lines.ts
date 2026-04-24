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

}

