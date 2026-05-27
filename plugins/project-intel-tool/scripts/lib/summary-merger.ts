import * as fs from 'fs';
import * as path from 'path';
import { DirectorySummary, FileSummary, PartialSummaries, SUMMARIES_FILE, SummariesData, SummariesDataStorage } from '../types';

export function getOrCreateSummaries(knowledgeDir: string): SummariesData {
  const summariesPath = path.join(knowledgeDir, SUMMARIES_FILE);

  if (fs.existsSync(summariesPath)) {  
    try {
      const storage = JSON.parse(fs.readFileSync(summariesPath, 'utf8')) as SummariesDataStorage;
      return {
        generated: storage.generated,
        directories: new Map(Object.entries(storage.directories)),
        files: new Map(Object.entries(storage.files))
      };
    } catch (e) {
      console.error(`Error reading ${SUMMARIES_FILE}, creating new:`, e);
    }
  }

  return {
    generated: new Date().toISOString(),
    directories: new Map<string, DirectorySummary>(),
    files: new Map<string, FileSummary>(),
  };
}

export function writeSummaries(knowledgeDir: string, data: SummariesData): void {
  const summariesPath = path.join(knowledgeDir, 'summaries.json');
  const tempPath = summariesPath + '.tmp';

  // Update generated timestamp
  const storage: SummariesDataStorage = {
    generated: new Date().toISOString(),
    directories: Object.fromEntries(data.directories),
    files: Object.fromEntries(data.files)
  }

  // Write to temp file, then rename (atomic operation)
  fs.writeFileSync(tempPath, JSON.stringify(storage, null, 2));
  fs.renameSync(tempPath, summariesPath);
}

export function mergeSummaries(knowledgeDir: string, partialSummaries: PartialSummaries): SummariesData {
  const summaries = getOrCreateSummaries(knowledgeDir);

  // Merge directories
  if (partialSummaries.directories) {
    for (const dirSummary of partialSummaries.directories) {
      if(dirSummary.technologies && dirSummary.technologies.length == 0) dirSummary.technologies = undefined;

      summaries.directories.set(dirSummary.path, {
        ...dirSummary,
        lastUpdated: new Date().toISOString()
      } as DirectorySummary);
    }
  }

  // Merge files
  if (partialSummaries.files) {
    for (const fileSummary of partialSummaries.files) {
      if(fileSummary.exports && fileSummary.exports.length == 0) fileSummary.exports = undefined;
      if(fileSummary.imports && fileSummary.imports.length == 0) fileSummary.imports = undefined;

      summaries.files.set(fileSummary.path, {
        ...fileSummary,
        lastUpdated: new Date().toISOString()
      });
    }   
  }

  writeSummaries(knowledgeDir, summaries);
  return summaries;
}