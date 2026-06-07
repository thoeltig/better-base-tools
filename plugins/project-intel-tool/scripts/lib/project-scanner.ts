import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getOrCreateSummaries, writeSummaries, markFilesAsDeleted, isSummariesFile, toAbsReal } from './summary-merger.js';
import { KNOWLEDGE_DIRECTORY, SUMMARIES_FILE, ScanConfig, SubKnowledgeRef, SummariesData } from '../types.js';
import { buildFileMap } from './file-map.js';

export interface ScanResult {
  filesToScan: string[];
  subKnowledge: SubKnowledgeRef[];
  projectStats: {
    knowledgeDir: string;
    totalFilesInKnowledge: number;
    numberOfFilesToScan: number;
    changedFilesCount: number;
    unanalyzedFilesCount: number;
    extensionCountsOfFilesToScan: Record<string, number>;
  };
}

interface Files {
  new: string[];
  modified: string[];
  deleted: string[];
}

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '__pycache__', 'target',
  'bin', 'obj', '.git', '.svn', 'coverage', '.pytest_cache', '.venv',
  'venv', '.env', '.idea', '.meteor', '.angular', '.vscode', '.vs',
  'vendor', 'tmp', '.cache',
]);

function shouldIgnore(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function isWithinDir(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPathExcluded(absPath: string, excludeAbsPaths: string[]): boolean {
  return excludeAbsPaths.some(excl => isWithinDir(absPath, excl));
}

function resolveConfigPaths(
  includePaths: string[],
  excludePaths: string[],
  location: string
): { includes: string[]; excludes: string[] } {
  const base = toAbsReal(location, '.');
  const excludes = excludePaths
    .map(p => toAbsReal(base, p))
    .filter(p => isWithinDir(p, base));
  const includes = includePaths
    .map(p => toAbsReal(base, p))
    .filter(p => isWithinDir(p, base))
    .filter(p => !excludes.some(excl => isWithinDir(p, excl)));
  return { includes, excludes };
}

function isGitRepository(): boolean {
  try { execSync('git rev-parse --git-dir', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function getGitRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

function toRelative(absPath: string, projectRoot: string): string {
  return path.relative(toAbsReal(projectRoot, '.'), absPath).replace(/\\/g, '/');
}

function getSummaryFileMap(summaries: SummariesData): Map<string, Date> {
  const map = new Map<string, Date>();
  summaries.files.forEach((val, key) => {
    if (!val.deleted) map.set(key, val.lastUpdated ? new Date(val.lastUpdated) : new Date());
  });
  return map;
}

function getFilesFromGit(location: string, summaries: SummariesData, projectRoot: string, excludeAbsPaths: string[]): Files {
  const files: Files = { new: [], modified: [], deleted: [] };
  try {
    const gitRoot = getGitRoot();
    const gitLocation = location.replace(/\\/g, '/');
    const tracked = execSync(`git ls-files --full-name -- "${gitLocation}"`, { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean)
      .filter(f => !f.split('/').some(shouldIgnore))
      .map(f => toAbsReal(projectRoot, path.resolve(gitRoot, f)))
      .filter(absPath => !isPathExcluded(absPath, excludeAbsPaths));

    const summaryMap = getSummaryFileMap(summaries);
    if (summaryMap.size === 0) {
      files.new.push(...tracked);
      return files;
    }

    let since = new Date();
    summaryMap.forEach(d => { if (d < since) since = d; });

    const output = execSync(
      `git log --format=%ai --name-only --since="${since.toISOString()}" -- "${gitLocation}"`,
      { encoding: 'utf-8' }
    );

    const modifiedMap = new Map<string, Date>();
    let currentDate: Date | null = null;
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      if (line.match(/^\d{4}-\d{2}-\d{2}/)) {
        currentDate = new Date(line);
      } else if (currentDate && !line.split('/').some(shouldIgnore)) {
        const absPath = toAbsReal(projectRoot, path.resolve(gitRoot, line));
        if (isPathExcluded(absPath, excludeAbsPaths)) continue;
        const lastUpdated = summaryMap.get(absPath);
        if ((!lastUpdated || lastUpdated < currentDate) && !modifiedMap.has(absPath) && fs.existsSync(absPath)) {
          modifiedMap.set(absPath, currentDate);
        }
      }
    }

    const trackedSet = new Set(tracked);
    tracked.forEach(absPath => { if (!summaryMap.has(absPath)) files.new.push(absPath); });

    summaryMap.forEach((_, absPath) => {
      if (isWithinDir(absPath, location) && !trackedSet.has(absPath) && !fs.existsSync(absPath)) {
        files.deleted.push(absPath);
      }
    });

    files.modified.push(...modifiedMap.keys());
    return files;
  } catch {
    return files;
  }
}

function scanDirRecursive(
  dir: string,
  filePaths: Map<string, Date>,
  subKnowledge: SubKnowledgeRef[],
  projectRoot: string,
  excludeAbsPaths: string[] = []
): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (shouldIgnore(entry)) continue;
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === KNOWLEDGE_DIRECTORY) {
          if (fs.existsSync(path.join(fullPath, SUMMARIES_FILE))) {
            subKnowledge.push({
              location: toRelative(dir, projectRoot),
              knowledgeDir: toRelative(fullPath, projectRoot),
            });
          }
          continue;
        }
        if (isPathExcluded(fullPath, excludeAbsPaths)) continue;
        scanDirRecursive(fullPath, filePaths, subKnowledge, projectRoot, excludeAbsPaths);
      } else if (stat.isFile()) {
        filePaths.set(toAbsReal(projectRoot, fullPath), stat.mtime);
      }
    }
  } catch {}
}

function getFilesFromFileSystem(
  location: string,
  summaries: SummariesData,
  projectRoot: string,
  subKnowledge: SubKnowledgeRef[],
  excludeAbsPaths: string[] = []
): Files {
  const files: Files = { new: [], modified: [], deleted: [] };
  try {
    const fsFiles = new Map<string, Date>();
    scanDirRecursive(location, fsFiles, subKnowledge, projectRoot, excludeAbsPaths);

    const summaryMap = getSummaryFileMap(summaries);
    if (summaryMap.size === 0) {
      fsFiles.forEach((_, absPath) => files.new.push(absPath));
      return files;
    }

    fsFiles.forEach((mtime, absPath) => {
      const lastDate = summaryMap.get(absPath);
      if (!lastDate) files.new.push(absPath);
      else if (mtime > lastDate) files.modified.push(absPath);
    });

    const fsAbsSet = new Set(fsFiles.keys());
    summaryMap.forEach((_, absPath) => {
      if (isWithinDir(absPath, location) && !fsAbsSet.has(absPath)) {
        files.deleted.push(absPath);
      }
    });
    return files;
  } catch {
    return files;
  }
}

function searchForKnowledgeDir(dir: string): string | undefined {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue;
      } catch { continue; }
      if (entry === KNOWLEDGE_DIRECTORY && fs.existsSync(path.join(fullPath, SUMMARIES_FILE))) {
        return toAbsReal(dir, fullPath);
      }
      const result = searchForKnowledgeDir(fullPath);
      if (result) return result;
    }
  } catch {}
  return undefined;
}

export function findKnowledgeDir(location: string): string | undefined {
  if (isGitRepository()) {
    try {
      const gitRoot = getGitRoot();
      const target = (KNOWLEDGE_DIRECTORY + '/' + SUMMARIES_FILE);
      const found = execSync(`git ls-files --full-name -- "${location}"`, { encoding: 'utf-8' })
        .trim().split('\n')
        .find(f => f.replace(/\\/g, '/').endsWith(target));
      if (found) {
        return toAbsReal(gitRoot, path.dirname(path.resolve(gitRoot, found)));
      }
    } catch {}
  }
  return searchForKnowledgeDir(location);
}

export async function scanProject(location: string, knowledgeDir: string, scanConfig: ScanConfig): Promise<ScanResult> {
  const projectRoot = toAbsReal(path.dirname(knowledgeDir), '.');
  const summaries = getOrCreateSummaries(knowledgeDir, projectRoot);
  const resolvedLocation = toAbsReal(location, '.');

  if (!fs.existsSync(resolvedLocation)) {
    return {
      filesToScan: [],
      subKnowledge: summaries.subKnowledge,
      projectStats: { knowledgeDir, totalFilesInKnowledge: summaries.files.size, numberOfFilesToScan: 0, changedFilesCount: 0, unanalyzedFilesCount: 0, extensionCountsOfFilesToScan: {} },
    };
  }

  const detectedSubKnowledge: SubKnowledgeRef[] = [...summaries.subKnowledge];
  let files: Files;

  const { includes: includeAbsPaths, excludes: excludeAbsPaths } = resolveConfigPaths(
    scanConfig.includePaths, scanConfig.excludePaths, resolvedLocation
  );
  const allExcludePaths = [...excludeAbsPaths, path.resolve(knowledgeDir)];

  if (isGitRepository()) {
    files = getFilesFromGit(resolvedLocation, summaries, projectRoot, allExcludePaths);
    for (const inclPath of includeAbsPaths) {
      if (fs.existsSync(inclPath)) {
        const inclFiles = getFilesFromFileSystem(inclPath, summaries, projectRoot, detectedSubKnowledge, allExcludePaths);
        files.new.push(...inclFiles.new);
        files.modified.push(...inclFiles.modified);
        files.deleted.push(...inclFiles.deleted);
      }
    }
  } else {
    files = getFilesFromFileSystem(resolvedLocation, summaries, projectRoot, detectedSubKnowledge, allExcludePaths);
  }

  files.deleted = [...new Set(files.deleted)];

  if (files.deleted.length > 0) {
    markFilesAsDeleted(files.deleted, summaries, knowledgeDir, projectRoot);
  }

  const existingRefKeys = new Set(summaries.subKnowledge.map(r => r.knowledgeDir));
  const newRefs = detectedSubKnowledge.filter(r => !existingRefKeys.has(r.knowledgeDir));
  if (newRefs.length > 0) {
    summaries.subKnowledge.push(...newRefs);
    writeSummaries(knowledgeDir, summaries, projectRoot);
  }

  // Files arrays hold abs paths; convert to relative for buildFileMap and output
  const changedSet = new Set([...files.new, ...files.modified]);
  const unanalyzedAbs = [...summaries.files.entries()]
    .filter(([absPath, v]) => !v.deleted && !v.summary && fs.existsSync(absPath))
    .map(([absPath]) => absPath);
  const unanalyzedFilesCount = unanalyzedAbs.filter(abs => !changedSet.has(abs)).length;
  const uniqueAbs = [...new Set([...files.new, ...files.modified, ...unanalyzedAbs])].filter(f => !isSummariesFile(f));
  const changedFilesCount = uniqueAbs.filter(abs => changedSet.has(abs)).length;
  const unique = uniqueAbs.map(abs => toRelative(abs, projectRoot));

  if (unique.length > 0) {
    const allProjectFiles = [...new Set([
      ...unique,
      ...[...summaries.files.entries()].filter(([, v]) => !v.deleted)
        .map(([abs]) => toRelative(abs, projectRoot)),
    ])];
    const summariesRelPath = toRelative(toAbsReal(knowledgeDir, SUMMARIES_FILE), projectRoot);
    const fileMap = buildFileMap(unique, projectRoot, allProjectFiles);
    for (let i = 0; i < unique.length; i++) {
      const relPath = unique[i]!;
      const absPath = uniqueAbs[i]!;
      const fm = fileMap.get(relPath) ?? { imports: [], exports: [], refs: [], sizeChars: 0, lineCount: 0 };
      const existing = summaries.files.get(absPath) ?? {};
      const refs = fm.refs.filter(r => r !== summariesRelPath);
      const wasAnalyzed = !!existing.summary;
      const hasChanged = changedSet.has(absPath);
      const hasPriorMetrics = existing.sizeCharsWhenAnalysed !== undefined && existing.lineCountWhenAnalysed !== undefined;
      const shouldComputeDelta = wasAnalyzed && hasChanged && hasPriorMetrics;
      let analysisDelta: string | undefined;
      if (shouldComputeDelta) {
        const deltaLines = fm.lineCount - existing.lineCountWhenAnalysed!;
        const deltaChars = fm.sizeChars - existing.sizeCharsWhenAnalysed!;
        if (deltaLines !== 0 || deltaChars !== 0) {
          analysisDelta = `${deltaLines >= 0 ? '+' : ''}${deltaLines} lines ${deltaChars >= 0 ? '+' : ''}${deltaChars} chars`;
        }
      }
      summaries.files.set(absPath, {
        ...existing,
        sizeChars: fm.sizeChars,
        lineCount: fm.lineCount,
        ...(fm.exports.length > 0 ? { exports: fm.exports } : {}),
        ...(fm.imports.length > 0 ? { imports: fm.imports } : {}),
        ...(refs.length > 0 ? { refs } : {}),
        deleted: false,
        ...(analysisDelta !== undefined ? { analysisDelta } : {}),
      });
    }
    writeSummaries(knowledgeDir, summaries, projectRoot);
  }

  const extCounts = unique.reduce((acc, f) => {
    const ext = path.extname(f).toLowerCase() || 'none';
    acc[ext] = (acc[ext] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return {
    filesToScan: unique,
    subKnowledge: summaries.subKnowledge,
    projectStats: {
      knowledgeDir,
      totalFilesInKnowledge: [...summaries.files.values()].filter(f => !f.deleted).length,
      numberOfFilesToScan: unique.length,
      changedFilesCount,
      unanalyzedFilesCount,
      extensionCountsOfFilesToScan: extCounts,
    },
  };
}
