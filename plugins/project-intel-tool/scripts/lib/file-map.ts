import * as fs from 'fs';
import * as path from 'path';

export interface FileRefs {
  imports: string[];   // resolved intra-project paths (TS/JS) or namespace strings (C#)
  exports: string[];   // named exports / public type names
  refs: string[];      // all intra-project file path mentions
  sizeChars: number;
  lineCount: number;
}

const TS_JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

// Matches: import ... from '...', import('...'), require('...')
const TS_IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|import\(|require\()['"]([^'"]+)['"]/g;
// Matches: export [default] [abstract] class|function*?|const|let|var|interface|type|enum Name
const TS_EXPORT_NAMED_RE = /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?(?:class|function\*?|const|let|var|interface|type|enum)\s+(\w+)/g;
// Matches: export { a, b as c }
const TS_EXPORT_BRACE_RE = /\bexport\s*\{([^}]+)\}/g;

// C# using directives (namespace strings, not file paths)
const CS_USING_RE = /^\s*using\s+([\w.]+)\s*;/gm;
// C# public type declarations
const CS_TYPE_RE = /(?:public|internal)\s+(?:static\s+)?(?:partial\s+)?(?:sealed\s+)?(?:abstract\s+)?(?:class|interface|struct|enum|record)\s+(\w+)/g;

// Relative path mentions: ./foo/bar.ts or ../baz.json
const REL_PATH_RE = /(?:^|[\s"'`(])(\.\.?\/[a-zA-Z0-9_.\-/]+\.[a-zA-Z]{1,6})(?:[\s"'`)]|$)/gm;
// Bare path mentions: src/foo/bar.ts
const BARE_PATH_RE = /\b([a-zA-Z0-9_][a-zA-Z0-9_.\-]*\/[a-zA-Z0-9_.\-/]+\.[a-zA-Z]{1,6})\b/g;

function resolveImport(
  importPath: string,
  fromFile: string,
  projectFileSet: Set<string>,
  projectRoot: string
): string | null {
  if (!importPath.startsWith('.')) return null; // external package
  const fromDir = path.dirname(path.resolve(projectRoot, fromFile));
  const resolved = path.resolve(fromDir, importPath);
  const rel = path.relative(projectRoot, resolved).replace(/\\/g, '/');

  // Exact match
  if (projectFileSet.has(rel)) return rel;

  // Try adding extensions and /index variants
  for (const ext of RESOLVE_EXTS) {
    const withExt = rel + ext;
    if (projectFileSet.has(withExt)) return withExt;
    const asIndex = rel + '/index' + ext;
    if (projectFileSet.has(asIndex)) return asIndex;
  }
  return null;
}

function parseTsJs(
  content: string,
  filePath: string,
  projectFileSet: Set<string>,
  projectRoot: string
): Pick<FileRefs, 'imports' | 'exports' | 'refs'> {
  const imports: string[] = []; // external package names
  const exports: string[] = [];
  const refs: string[] = [];   // resolved intra-project file paths

  TS_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TS_IMPORT_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    if (cap.startsWith('.')) {
      const resolved = resolveImport(cap, filePath, projectFileSet, projectRoot);
      if (resolved && !refs.includes(resolved)) refs.push(resolved);
    } else {
      const pkg = cap.startsWith('@') ? cap.split('/').slice(0, 2).join('/') : cap.split('/')[0]!;
      if (pkg && !imports.includes(pkg)) imports.push(pkg);
    }
  }

  TS_EXPORT_NAMED_RE.lastIndex = 0;
  while ((m = TS_EXPORT_NAMED_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    if (!exports.includes(cap)) exports.push(cap);
  }

  TS_EXPORT_BRACE_RE.lastIndex = 0;
  while ((m = TS_EXPORT_BRACE_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    for (const part of cap.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && !exports.includes(name)) exports.push(name);
    }
  }

  return { imports, exports, refs };
}

function parseCSharp(content: string): Pick<FileRefs, 'imports' | 'exports' | 'refs'> {
  const imports: string[] = [];
  const exports: string[] = [];

  CS_USING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CS_USING_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    if (!imports.includes(cap)) imports.push(cap);
  }

  CS_TYPE_RE.lastIndex = 0;
  while ((m = CS_TYPE_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    if (!exports.includes(cap)) exports.push(cap);
  }

  return { imports, exports, refs: [] };
}

function parseText(content: string, projectFileSet: Set<string>): Pick<FileRefs, 'imports' | 'exports' | 'refs'> {
  const refs: string[] = [];

  REL_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REL_PATH_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    const p = cap.replace(/^\.\//,  '');
    if (projectFileSet.has(p) && !refs.includes(p)) refs.push(p);
  }

  BARE_PATH_RE.lastIndex = 0;
  while ((m = BARE_PATH_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    if (projectFileSet.has(cap) && !refs.includes(cap)) refs.push(cap);
  }

  return { imports: [], exports: [], refs };
}

export function parseFileRefs(
  filePath: string,
  content: string,
  projectFileSet: Set<string>,
  projectRoot: string
): FileRefs {
  const ext = path.extname(filePath).toLowerCase();
  const sizeChars = content.length;
  const lineCount = content.split('\n').length;

  let parsed: Pick<FileRefs, 'imports' | 'exports' | 'refs'>;
  if (TS_JS_EXTS.has(ext)) {
    parsed = parseTsJs(content, filePath, projectFileSet, projectRoot);
  } else if (ext === '.cs') {
    parsed = parseCSharp(content);
  } else {
    parsed = parseText(content, projectFileSet);
  }

  return { ...parsed, sizeChars, lineCount };
}

export function buildFileMap(files: string[], projectRoot: string): Map<string, FileRefs> {
  const projectFileSet = new Set(files);
  const map = new Map<string, FileRefs>();

  for (const filePath of files) {
    const absPath = path.resolve(projectRoot, filePath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      map.set(filePath, parseFileRefs(filePath, content, projectFileSet, projectRoot));
    } catch {
      map.set(filePath, { imports: [], exports: [], refs: [], sizeChars: 0, lineCount: 0 });
    }
  }

  return map;
}
