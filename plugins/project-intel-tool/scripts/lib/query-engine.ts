
import { existsSync } from 'fs';
import { basename, dirname, extname, relative, resolve } from 'path';
import { getOrCreateSummaries } from './summary-merger.js';
import { 
  FileRole,
  FluentFile,
  FluentOutput,
  FORMAT_GROUPED,
  FormatType,
  GroupedScoredFileSummary,
  HierarchicalGrouping,
  ScoredFileSummary,
  SubKnowledgeRef,
  VerbosityType
} from "../types.js";

export function query(knowledgeDir: string, keywords: string[], scope: string | undefined, maxResults: number, role: FileRole | undefined, subKnowledgeOverride?: SubKnowledgeRef[]): ScoredFileSummary[] {
  const projectRoot = dirname(resolve(knowledgeDir));
  const scored: ScoredFileSummary[] = [];
  const visited = new Set<string>();
  
  const scoreFiles = (summaries: ReturnType<typeof getOrCreateSummaries>, pathPrefix: string, summaryProjectRoot: string) => {
    summaries.files.forEach((summary, absPath) => {
      if (summary.deleted) return;
      const relPath = relative(summaryProjectRoot, absPath).replace(/\\/g, '/');
      const prefixedPath = pathPrefix ? `${pathPrefix}/${relPath}`.replace(/\/\//g, '/') : relPath;
      if (scope && !prefixedPath.startsWith(scope)) return;
      if (role && summary.role !== role) return;
      const score = calculateConfidence(keywords, prefixedPath, summary);
      if (score > 0) {
        const { lastUpdated: _ld, ...summaryRest } = summary;
        scored.push({ fileScore: score, path: prefixedPath, ...summaryRest });
      }
    });
  };

  // Recursively aggregate a knowledge base and every nested sub-knowledge base it references.
  // Refs come from each base's stored `subKnowledge` (collected at scan time), so no filesystem
  // walk happens here; `refsOverride` seeds the first level when no top-level base exists yet.
  const aggregate = (kDir: string, kProjectRoot: string, pathPrefix: string, refsOverride?: SubKnowledgeRef[]): void => {
    const dirKey = resolve(kDir);
    if (visited.has(dirKey)) return;
    visited.add(dirKey);

    const summaries = getOrCreateSummaries(kDir, kProjectRoot);
    scoreFiles(summaries, pathPrefix, kProjectRoot);

    const refs = refsOverride ?? summaries.subKnowledge;
    for (const ref of refs) {
      const childDir = resolve(kProjectRoot, ref.knowledgeDir);
      if (!existsSync(childDir)) continue;
      const childProjectRoot = dirname(childDir);
      const childPrefix = pathPrefix ? `${pathPrefix}/${ref.location}`.replace(/\/\//g, '/') : ref.location;
      aggregate(childDir, childProjectRoot, childPrefix);
    }
  };

  aggregate(knowledgeDir, projectRoot, '', subKnowledgeOverride);

  scored.sort((a, b) => b.fileScore - a.fileScore);
  return scored.slice(0, maxResults);
}

export function generateQueryOutput(queryResult: ScoredFileSummary[], format: FormatType, verbosity: VerbosityType) {
  let output: FluentOutput;
  if (format === FORMAT_GROUPED) {
    const groupValues = groupScoredFiles(queryResult);
    const fallbackToFlat = queryResult.length === 1 || groupValues.every(g => g.files.length === 1);
    if (fallbackToFlat) {
      output = createFlatOutput(queryResult, verbosity);
    } else {
      output = {
        total: queryResult.length,
        grouped: groupValues
          .sort((a, b) => b.folderScore - a.folderScore)
          .map(({ folderScore: _fs, ...rest }) => rest),
      };
    }
  } else {
    output = createFlatOutput(queryResult, verbosity);
  }

  return output;
}

function groupScoredFiles(limited: ScoredFileSummary[]) : HierarchicalGrouping[] {
  const grouped: Record<string, HierarchicalGrouping> = {};
  limited.forEach(item => {
    const folderPath = dirname(item.path).replace(/\\/g, '/') || '.';
    if (!grouped[folderPath]) {
      grouped[folderPath] = { folderPath, folderScore: 0, files: [] };
    }
    const group = grouped[folderPath]!;
    group.folderScore += item.fileScore;
    if (item.technologies?.length) {
      const set = new Set(group.technologies ?? []);
      item.technologies.forEach(t => set.add(t));
      group.technologies = [...set];
    }
    const fileName = basename(item.path);
    const { path: _p, technologies: _t, lastUpdated: _ld, deleted: _del, sizeCharsWhenAnalysed: _sca, lineCountWhenAnalysed: _lcwa, fileScore: _score, searchTags: _stags, ...restFields } = item;
    const f: GroupedScoredFileSummary = { fileName, ...restFields };
    group.files.push(f);
  });
  return Object.values(grouped);
}

function renderImports(imports: Record<string, string[]> | undefined): string | null {
  if (!imports) return null;
  const entries = Object.entries(imports);
  if (entries.length === 0) return null;
  return entries
    .filter(([, names]) => Array.isArray(names))
    .map(([src, names]) => {
      const label = extname(src) ? basename(src) : src;
      return names.length > 0 ? `${names.join(', ')} from ${label}` : label;
    })
    .join(' | ') || null;
}

function fileEntryToFluent(name: string, file: FluentFile, includeTech: boolean, verbosity: VerbosityType = 'full'): string {
  const showTech = verbosity !== 'structure' && includeTech && (file.technologies?.length ?? 0) > 0;
  const techStr = showTech ? ` | ${file.technologies!.join(', ')}` : '';
  const meta = `<!-- ${name}${file.lineCount !== undefined ? ` (Lines: ${file.lineCount}, Chars: ${file.sizeChars})` : ''}${file.role ? ` [${file.role}]` : ''}${techStr} -->`;
  const parts: string[] = [meta];
  if (verbosity !== 'structure' && file.summary) parts.push(file.summary);
  if (verbosity !== 'structure' && file.analysisDelta) parts.push(`unanalysed: ${file.analysisDelta}`);
  if (verbosity !== 'semantic') {
    const importsStr = renderImports(file.imports);
    if (importsStr) parts.push(`imports: ${importsStr}`);
  }
  if (verbosity !== 'semantic' && file.exports?.length) parts.push(`exports: ${file.exports.join(', ')}`);
  if (verbosity !== 'semantic' && file.refs?.length) parts.push(`referenced: ${file.refs.join(', ')}`);
  return parts.join('\n');
}

export function outputToFluentText(output: FluentOutput, verbosity: VerbosityType = 'full'): string {
  if (output.grouped) {
    return output.grouped.map(group => {
      const showTech = verbosity !== 'structure' && (group.technologies?.length ?? 0) > 0;
      const techStr = showTech ? ` | ${group.technologies!.join(', ')}` : '';
      const header = `<!-- ${group.folderPath}${techStr} -->`;
      const files = group.files.map(f => fileEntryToFluent(f.fileName, f, false, verbosity)).join('\n\n');
      return `${header}\n${files}`;
    }).join('\n\n');
  }
  return (output.results ?? []).map(item => fileEntryToFluent(item.path, item, true, verbosity)).join('\n\n');
}

function createFlatOutput(items: ScoredFileSummary[], verbosity: VerbosityType = 'full'): FluentOutput {
  return {
    total: items.length,
    results: items.map(({ deleted: _del, lastUpdated: _ld, sizeCharsWhenAnalysed: _sca, lineCountWhenAnalysed: _lcwa, fileScore: _score, searchTags: _stags, ...rest }) => {
      if (verbosity === 'structure') {
        const { summary: _s, technologies: _t, analysisDelta: _a, ...structRest } = rest;
        return structRest;
      }
      if (verbosity === 'semantic') {
        const { imports: _i, exports: _e, refs: _r, lineCount: _lc, sizeChars: _sc, ...semanticRest } = rest;
        return semanticRest;
      }
      return rest;
    }),
  };
}

export function calculateConfidence(keywords: string[], itemPath: string, summary: any): number {
  let score = 0;
  const pathLower = itemPath.toLowerCase();
  const sumLower = (summary.summary || '').toLowerCase();
  const baseline = summary.sizeCharsWhenAnalysed;
  const current = summary.sizeChars;
  const semanticWeight = (baseline && current)
    ? Math.min(baseline, current) / Math.max(baseline, current)
    : 1;
  keywords.forEach(k => {
    if (sumLower.includes(k)) score += 6 * semanticWeight;
    if (summary.searchTags?.some((t: string) => t.toLowerCase().includes(k))) score += 3 * semanticWeight;
    if (summary.exports?.some((e: string) => e.toLowerCase().includes(k))) score += 4;
    if (summary.imports) {
      if (Object.keys(summary.imports).some((src: string) => src.toLowerCase().includes(k))) score += 4;
      const names = (Object.values(summary.imports) as string[][]).flat();
      if (names.some((name: string) => name.toLowerCase().includes(k))) score += 3;
    }
    if (summary.refs?.some((r: string) => r.toLowerCase().includes(k))) score += 3;
    if (pathLower.includes(k)) score += 4;
    if (summary.technologies?.some((t: string) => t.toLowerCase().includes(k))) score += 2 * semanticWeight;
    if (summary.role?.toLowerCase().includes(k)) score += 2 * semanticWeight;
  });
  return score;
}