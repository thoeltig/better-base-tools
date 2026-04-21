const SIMILARITY_THRESHOLD = 0.3;
const MAX_FILE_LINES_FOR_HINT = 5000;

/**
 * Classic Levenshtein distance (single-row DP). Not allocating a full matrix.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insertion = curr[j - 1]! + 1;
      const deletion = prev[j]! + 1;
      const substitution = prev[j - 1]! + cost;
      curr[j] = Math.min(insertion, deletion, substitution);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Best 1-indexed line number in `content` whose content most resembles the first
 * non-empty line of `needle`. Returns undefined if similarity is below threshold
 * or if the file is too large to analyze cheaply.
 */
export function findNearestLine(
  content: string,
  needle: string,
): number | undefined {
  const probe = firstNonEmptyLine(needle);
  if (probe === undefined || probe.length === 0) return undefined;

  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_FILE_LINES_FOR_HINT) return undefined;

  let bestLine = 0;
  let bestSim = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const maxLen = Math.max(probe.length, line.length);
    if (maxLen === 0) continue;

    // Cheap upper-bound prune: if length diff alone already pushes similarity
    // below threshold, skip the expensive Levenshtein.
    const lenDiff = Math.abs(probe.length - line.length);
    const maxPossibleSim = 1 - lenDiff / maxLen;
    if (maxPossibleSim <= bestSim || maxPossibleSim < SIMILARITY_THRESHOLD) continue;

    const sim = similarity(probe, line);
    if (sim > bestSim) {
      bestSim = sim;
      bestLine = i + 1;
    }
  }

  if (bestSim < SIMILARITY_THRESHOLD) return undefined;
  return bestLine;
}

function firstNonEmptyLine(s: string): string | undefined {
  for (const line of s.split(/\r?\n/)) {
    if (line.trim().length > 0) return line;
  }
  return undefined;
}
