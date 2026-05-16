const PATTERNS: RegExp[] = [
  // ES/TS: import ... from 'path', export ... from 'path', import 'side-effect'
  /(?:from|import)\s+['"`]([^'"`\n]+)['"`]/g,
  // require('path')
  /\brequire\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g,
  // Markdown links and images: [text](path) / ![alt](path)
  /!?\[[^\]]*\]\(([^)\s]+)\)/g,
  // Relative path literals in any string context: './foo', '../bar'
  /['"`](\.\.?\/[^'"`\n]+)['"`]/g,
  // Absolute Windows path literals: 'C:/foo/bar' or 'C:\foo\bar'
  /['"`]([a-zA-Z]:[/\\][^'"`\n]+)['"`]/g,
];

function isFileRef(ref: string): boolean {
  if (ref.startsWith('http://') || ref.startsWith('https://')) return false;
  return (
    ref.startsWith('./') ||
    ref.startsWith('../') ||
    ref.startsWith('/') ||
    /^[a-zA-Z]:[/\\]/.test(ref)
  );
}

export function extractRefs(content: string): string[] {
  const seen = new Set<string>();
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const ref = match[1]?.trim();
      if (ref && isFileRef(ref)) seen.add(ref);
    }
  }
  return Array.from(seen).sort();
}
