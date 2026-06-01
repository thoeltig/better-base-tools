import * as fs from 'fs';
import * as path from 'path';
import {
  FileSummary,
  KNOWLEDGE_DIRECTORY,
  SamplingFileSummary,
  SUMMARIES_FILE,
  SummariesData,
  SummariesDataStorage,
} from '../types.js';

export function isSummariesFile(filePath: string): boolean {
  const parts = filePath.split('/').flatMap(p => p.split('\\'));
  const idx = parts.lastIndexOf(KNOWLEDGE_DIRECTORY);
  return idx !== -1 && parts[idx + 1] === SUMMARIES_FILE;
}

export function toAbsReal(base: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

export function getOrCreateSummaries(knowledgeDir: string, projectRoot: string): SummariesData {
  const summariesPath = path.join(knowledgeDir, SUMMARIES_FILE);
  if (fs.existsSync(summariesPath)) {
    try {
      const storage = JSON.parse(fs.readFileSync(summariesPath, 'utf8')) as SummariesDataStorage;
      const files = new Map<string, FileSummary>();
      for (const [key, value] of Object.entries(storage.files)) {
        const absKey = toAbsReal(projectRoot, key);
        const existing = files.get(absKey);
        if (
          !existing ||
          (existing.deleted && !value.deleted) ||
          (existing.deleted === value.deleted && !!value.lastUpdated && (!existing.lastUpdated || value.lastUpdated > existing.lastUpdated))
        ) {
          files.set(absKey, value);
        }
      }
      return {
        generated: storage.generated,
        files,
        subKnowledge: storage.subKnowledge || [],
      };
    } catch (e) {
      console.error(`[summary-merger] Error reading ${SUMMARIES_FILE}, creating new:`, e);
    }
  }
  return {
    generated: new Date().toISOString(),
    files: new Map<string, FileSummary>(),
    subKnowledge: [],
  };
}

export function writeSummaries(knowledgeDir: string, data: SummariesData, projectRoot: string): void {
  const summariesPath = path.join(knowledgeDir, SUMMARIES_FILE);
  const tempPath = summariesPath + '.tmp';
  const absRoot = toAbsReal(projectRoot, '.');
  const storage: SummariesDataStorage = {
    generated: new Date().toISOString(),
    files: Object.fromEntries(
      [...data.files.entries()]
        .map(([absKey, v]) => [path.relative(absRoot, absKey).replace(/\\/g, '/'), v] as const)
        .filter(([relKey]) => !isSummariesFile(relKey))
        .sort(([a], [b]) => a.localeCompare(b))
    ),
    ...(data.subKnowledge.length > 0 ? { subKnowledge: data.subKnowledge } : {}),
  };
  fs.writeFileSync(tempPath, JSON.stringify(storage, null, 2));
  fs.renameSync(tempPath, summariesPath);
}

export function mergeSamplingResults(knowledgeDir: string, results: SamplingFileSummary[], projectRoot: string): SummariesData {
  const summaries = getOrCreateSummaries(knowledgeDir, projectRoot);
  for (const result of results) {
    const absPath = toAbsReal(projectRoot, result.path);
    const existing = summaries.files.get(absPath) || {};
    summaries.files.set(absPath, {
      ...existing,
      ...result,
      deleted: false,
      lastUpdated: new Date().toISOString(),
      sizeCharsWhenAnalysed: result.sizeChars ?? existing.sizeChars,
      lineCountWhenAnalysed: result.lineCount ?? existing.lineCount,
      analysisDelta: undefined,
    });
  }
  writeSummaries(knowledgeDir, summaries, projectRoot);
  return summaries;
}

export function markFilesAsDeleted(filePaths: string[], summaries: SummariesData, knowledgeDir: string, projectRoot: string): void {
  for (const filePath of filePaths) {
    const existing = summaries.files.get(filePath);
    if (existing) {
      summaries.files.set(filePath, { ...existing, deleted: true });
    }
  }
  writeSummaries(knowledgeDir, summaries, projectRoot);
}
