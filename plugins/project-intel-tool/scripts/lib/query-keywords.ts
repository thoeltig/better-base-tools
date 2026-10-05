/**
 * Splits a query string into lowercase keywords: whitespace separates terms, a double-quoted
 * span ("my folder/a.ts") stays one term. An unmatched quote is dropped.
 */
export function parseKeywords(raw: string): string[] {
  const terms: string[] = [];
  for (const match of raw.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]!.replace(/"/g, '')).trim().toLowerCase();
    if (term.length > 0) terms.push(term);
  }
  return terms;
}

/**
 * Lowercase, forward-slash form of a keyword or scope, comparable with project-relative file paths:
 * collapses duplicate slashes, strips a leading ./ and a trailing /, and makes an absolute path under
 * projectRoot relative. Plain words pass through unchanged.
 */
export function normalizePathTerm(term: string, projectRoot: string): string {
  let normalized = toComparablePath(term);
  const root = toComparablePath(projectRoot);
  if (normalized === root) return '';
  if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/** Whether a project-relative path lies under a normalized scope folder; an empty scope matches all. */
export function inScope(path: string, scope: string): boolean {
  if (scope === '') return true;
  const lower = path.toLowerCase();
  return lower === scope || lower.startsWith(`${scope}/`);
}

function toComparablePath(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}
