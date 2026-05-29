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

export function getOrCreateSummaries(knowledgeDir: string): SummariesData {
  const summariesPath = path.join(knowledgeDir, SUMMARIES_FILE);
  if (fs.existsSync(summariesPath)) {
    try {
      const storage = JSON.parse(fs.readFileSync(summariesPath, 'utf8')) as SummariesDataStorage;
      const files = new Map<string, FileSummary>();
      for (const [key, value] of Object.entries(storage.files)) {
        const normalizedKey = normalizePath(key);
        const existing = files.get(normalizedKey);
        if (
          !existing ||
          (existing.deleted && !value.deleted) ||
          (existing.deleted === value.deleted && !!value.lastUpdated && (!existing.lastUpdated || value.lastUpdated > existing.lastUpdated))
        ) {
          files.set(normalizedKey, value);
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

export function writeSummaries(knowledgeDir: string, data: SummariesData): void {
  const summariesPath = path.join(knowledgeDir, SUMMARIES_FILE);
  const tempPath = summariesPath + '.tmp';
  const storage: SummariesDataStorage = {
    generated: new Date().toISOString(),
    // Sort by file path for stable git diffs
    files: Object.fromEntries([...data.files.entries()].filter(([k]) => !isSummariesFile(k)).sort(([a], [b]) => a.localeCompare(b))),
    ...(data.subKnowledge.length > 0 ? { subKnowledge: data.subKnowledge } : {}),
  };
  fs.writeFileSync(tempPath, JSON.stringify(storage, null, 2));
  fs.renameSync(tempPath, summariesPath);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function mergeSamplingResults(knowledgeDir: string, results: SamplingFileSummary[]): SummariesData {
  const summaries = getOrCreateSummaries(knowledgeDir);
  for (const result of results) {
    const normalizedPath = normalizePath(result.path);
    const existing = summaries.files.get(normalizedPath) || {};
    summaries.files.set(normalizedPath, {
      ...existing,
      ...result,
      deleted: false,
      lastUpdated: new Date().toISOString(),
    });
  }
  writeSummaries(knowledgeDir, summaries);
  return summaries;
}

export function markFilesAsDeleted(filePaths: string[], summaries: SummariesData, knowledgeDir: string): void {
  for (const filePath of filePaths) {
    const existing = summaries.files.get(filePath);
    if (existing) {
      summaries.files.set(filePath, { ...existing, deleted: true });
    }
  }
  writeSummaries(knowledgeDir, summaries);
}
