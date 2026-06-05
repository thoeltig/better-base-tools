import * as fs from 'fs';
import * as path from 'path';

export interface FileRefs {
  imports: Record<string, string[]>; // key: resolved local path or package name, value: imported names
  exports: string[];                  // named exports / public type names
  refs: string[];                     // intra-project file mentions from non-import text (markdown links, bare refs)
  sizeChars: number;
  lineCount: number;
}

const TS_JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

// Matches full static import: import [type] <specifiers> from 'module'
// Group 1: specifier list, Group 2: module path
const TS_IMPORT_FULL_RE = /\bimport\s+(?:type\s+)?({[^}]*}|\*\s+as\s+\w[\w$]*|\w[\w$]*(?:\s*,\s*(?:{[^}]*}|\*\s+as\s+\w[\w$]*|\w[\w$]*))??)\s+from\s+['"]([^'"]+)['"]/g;
// Matches bare side-effect import: import 'module'
const TS_IMPORT_BARE_RE = /\bimport\s+['"]([^'"]+)['"]/g;
// Matches dynamic import: import('module')
const TS_DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
// Matches require: require('module')
const TS_REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
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

function parseImportSpecifiers(specStr: string): string[] {
  const trimmed = specStr.trim();
  if (trimmed.startsWith('{')) {
    return trimmed.slice(1, -1).split(',')
      .map(s => {
        const clean = s.trim().replace(/^type\s+/, '');
        const parts = clean.split(/\s+as\s+/);
        return (parts[1] ?? parts[0])?.trim() ?? '';
      })
      .filter(Boolean);
  }
  if (trimmed.startsWith('*')) {
    const m = trimmed.match(/\*\s+as\s+(\w[\w$]*)/);
    return m ? [m[1]!] : [];
  }
  // default or mixed: "Default" or "Default, { named }"
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) return trimmed ? [trimmed] : [];
  const defaultPart = trimmed.slice(0, commaIdx).trim();
  const namedPart = trimmed.slice(commaIdx + 1).trim();
  const names: string[] = defaultPart ? [defaultPart] : [];
  if (namedPart.startsWith('{')) {
    namedPart.slice(1, -1).split(',').forEach(n => {
      const clean = n.trim().replace(/^type\s+/, '');
      const alias = clean.split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0])?.trim();
      if (name) names.push(name);
    });
  } else if (namedPart.startsWith('*')) {
    const nsm = namedPart.match(/\*\s+as\s+(\w[\w$]*)/);
    if (nsm?.[1]) names.push(nsm[1]);
  }
  return names;
}

function addImport(imports: Record<string, string[]>, source: string, names: string[]): void {
  if (!imports[source]) imports[source] = [];
  for (const n of names) {
    if (!imports[source]!.includes(n)) imports[source]!.push(n);
  }
}

function resolvePackage(modulePath: string): string {
  return modulePath.startsWith('@')
    ? modulePath.split('/').slice(0, 2).join('/')
    : (modulePath.split('/')[0] ?? modulePath);
}

function parseTsJs(
  content: string,
  filePath: string,
  projectFileSet: Set<string>,
  projectRoot: string
): Pick<FileRefs, 'imports' | 'exports' | 'refs'> {
  const imports: Record<string, string[]> = {};
  const exports: string[] = [];
  const refs: string[] = [];

  let m: RegExpExecArray | null;

  // Full static imports: capture specifiers + module path
  TS_IMPORT_FULL_RE.lastIndex = 0;
  while ((m = TS_IMPORT_FULL_RE.exec(content)) !== null) {
    const specStr = m[1] ?? '';
    const modulePath = m[2];
    if (!modulePath) continue;
    const names = parseImportSpecifiers(specStr);
    if (modulePath.startsWith('.')) {
      const resolved = resolveImport(modulePath, filePath, projectFileSet, projectRoot);
      if (resolved) addImport(imports, resolved, names);
    } else {
      addImport(imports, resolvePackage(modulePath), names);
    }
  }

  // Bare side-effect imports: import 'module' — no specifiers
  TS_IMPORT_BARE_RE.lastIndex = 0;
  while ((m = TS_IMPORT_BARE_RE.exec(content)) !== null) {
    const modulePath = m[1];
    if (!modulePath) continue;
    if (modulePath.startsWith('.')) {
      const resolved = resolveImport(modulePath, filePath, projectFileSet, projectRoot);
      if (resolved && !refs.includes(resolved)) refs.push(resolved);
    } else {
      const pkg = resolvePackage(modulePath);
      if (!imports[pkg]) imports[pkg] = [];
    }
  }

  // Dynamic imports and require → local goes to refs, external adds empty entry
  TS_DYNAMIC_RE.lastIndex = 0;
  while ((m = TS_DYNAMIC_RE.exec(content)) !== null) {
    const modulePath = m[1];
    if (!modulePath) continue;
    if (modulePath.startsWith('.')) {
      const resolved = resolveImport(modulePath, filePath, projectFileSet, projectRoot);
      if (resolved && !refs.includes(resolved)) refs.push(resolved);
    } else {
      const pkg = resolvePackage(modulePath);
      if (!imports[pkg]) imports[pkg] = [];
    }
  }

  TS_REQUIRE_RE.lastIndex = 0;
  while ((m = TS_REQUIRE_RE.exec(content)) !== null) {
    const modulePath = m[1];
    if (!modulePath) continue;
    if (modulePath.startsWith('.')) {
      const resolved = resolveImport(modulePath, filePath, projectFileSet, projectRoot);
      if (resolved && !refs.includes(resolved)) refs.push(resolved);
    } else {
      const pkg = resolvePackage(modulePath);
      if (!imports[pkg]) imports[pkg] = [];
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
  const imports: Record<string, string[]> = {};
  const exports: string[] = [];

  CS_USING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CS_USING_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    if (!imports[cap]) imports[cap] = [];
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
  const imports: Record<string, string[]> = {};

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

  // Markdown links: handles extension-less files (e.g. LICENSE) not matched by REL_PATH_RE
  const MD_LINK_RE = /!?\[[^\]]*\]\(([^)\s#?]+)/g;
  while ((m = MD_LINK_RE.exec(content)) !== null) {
    const cap = m[1];
    if (!cap) continue;
    const p = cap.startsWith('./') ? cap.slice(2) : cap;
    if (projectFileSet.has(p) && !refs.includes(p)) refs.push(p);
  }

  return { imports, exports: [], refs };
}

export function parseFileRefs(
  filePath: string,
  content: string,
  projectFileSet: Set<string>,
  projectRoot: string
): FileRefs {
  const ext = path.extname(filePath).toLowerCase();
  const sizeChars = content.length;
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length - (content.endsWith('\n') || content.endsWith('\r') ? 1 : 0);

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

export function buildFileMap(files: string[], projectRoot: string, allProjectFiles?: string[]): Map<string, FileRefs> {
  const projectFileSet = new Set(allProjectFiles ?? files);
  const map = new Map<string, FileRefs>();

  for (const filePath of files) {
    const absPath = path.resolve(projectRoot, filePath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      map.set(filePath, parseFileRefs(filePath, content, projectFileSet, projectRoot));
    } catch {
      map.set(filePath, { imports: {}, exports: [], refs: [], sizeChars: 0, lineCount: 0 });
    }
  }

  return map;
}
