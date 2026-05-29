import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getOrCreateSummaries, writeSummaries, markFilesAsDeleted } from './summary-merger.js';
import { KNOWLEDGE_DIRECTORY, SUMMARIES_FILE, ScanConfig, SubKnowledgeRef, SummariesData } from '../types.js';

export interface ScanResult {
  filesToScan: string[];
  subKnowledge: SubKnowledgeRef[];
  projectStats: {
    knowledgeDir: string;
    totalFilesInKnowledge: number;
    numberOfFilesToScan: number;
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
  const base = path.resolve(location);
  const excludes = excludePaths
    .map(p => path.resolve(base, p))
    .filter(p => isWithinDir(p, base));
  const includes = includePaths
    .map(p => path.resolve(base, p))
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

// Normalize to forward-slash relative path from projectRoot using path.resolve to handle casing/symlinks
function toRelative(absOrGitPath: string, projectRoot: string): string {
  return path.relative(path.resolve(projectRoot), path.resolve(absOrGitPath)).replace(/\\/g, '/');
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
    const tracked = execSync(`git ls-files --full-name -- "${location}"`, { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean)
      .filter(f => !f.split('/').some(shouldIgnore))
      // git ls-files --full-name returns paths relative to git root
      .map(f => toRelative(path.resolve(gitRoot, f), projectRoot))
      .filter(relPath => !isPathExcluded(path.resolve(projectRoot, relPath), excludeAbsPaths));

    const summaryMap = getSummaryFileMap(summaries);
    if (summaryMap.size === 0) {
      files.new.push(...tracked);
      return files;
    }

    let since = new Date();
    summaryMap.forEach(d => { if (d < since) since = d; });

    const output = execSync(
      `git log --format=%ai --name-only --since="${since.toISOString()}" -- "${location}"`,
      { encoding: 'utf-8' }
    );

    const modifiedMap = new Map<string, Date>();
    let currentDate: Date | null = null;
    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      if (line.match(/^\d{4}-\d{2}-\d{2}/)) {
        currentDate = new Date(line);
      } else if (currentDate && !line.split('/').some(shouldIgnore)) {
        const absPath = path.resolve(gitRoot, line);
        if (isPathExcluded(absPath, excludeAbsPaths)) continue;
        const relPath = toRelative(absPath, projectRoot);
        const lastUpdated = summaryMap.get(relPath);
        if ((!lastUpdated || lastUpdated < currentDate) && !modifiedMap.has(relPath) && fs.existsSync(absPath)) {
          modifiedMap.set(relPath, currentDate);
        }
      }
    }

    const trackedSet = new Set(tracked);
    tracked.forEach(relPath => { if (!summaryMap.has(relPath)) files.new.push(relPath); });

    const resolvedLocation = path.resolve(location);
    summaryMap.forEach((_, relPath) => {
      const absPath = path.resolve(projectRoot, relPath);
      if (absPath.startsWith(resolvedLocation) && !trackedSet.has(relPath)) {
        files.deleted.push(relPath);
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
        // Detect nested .knowledge with summaries.json → skip subtree, record ref
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
        filePaths.set(fullPath, stat.mtime);
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
      fsFiles.forEach((_, absPath) => files.new.push(toRelative(absPath, projectRoot)));
      return files;
    }

    fsFiles.forEach((mtime, absPath) => {
      const relPath = toRelative(absPath, projectRoot);
      const lastDate = summaryMap.get(relPath);
      if (!lastDate) files.new.push(relPath);
      else if (mtime > lastDate) files.modified.push(relPath);
    });

    const fsRelSet = new Set([...fsFiles.keys()].map(a => toRelative(a, projectRoot)));
    const resolvedLocation = path.resolve(location);
    summaryMap.forEach((_, relPath) => {
      const absPath = path.resolve(projectRoot, relPath);
      if (absPath.startsWith(resolvedLocation) && !fsRelSet.has(relPath)) {
        files.deleted.push(relPath);
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
        return path.normalize(fullPath);
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
        return path.normalize(path.dirname(path.resolve(gitRoot, found)));
      }
    } catch {}
  }
  return searchForKnowledgeDir(location);
}

export async function scanProject(location: string, knowledgeDir: string, scanConfig: ScanConfig): Promise<ScanResult> {
  const summaries = getOrCreateSummaries(knowledgeDir);
  const projectRoot = path.dirname(path.resolve(knowledgeDir));
  const resolvedLocation = path.resolve(location);

  if (!fs.existsSync(resolvedLocation)) {
    return {
      filesToScan: [],
      subKnowledge: summaries.subKnowledge,
      projectStats: { knowledgeDir, totalFilesInKnowledge: summaries.files.size, numberOfFilesToScan: 0, extensionCountsOfFilesToScan: {} },
    };
  }

  // Sub-knowledge refs accumulate during filesystem walk
  const detectedSubKnowledge: SubKnowledgeRef[] = [...summaries.subKnowledge];
  let files: Files;

  const { includes: includeAbsPaths, excludes: excludeAbsPaths } = resolveConfigPaths(
    scanConfig.includePaths, scanConfig.excludePaths, resolvedLocation
  );

  if (isGitRepository()) {
    files = getFilesFromGit(resolvedLocation, summaries, projectRoot, excludeAbsPaths);
    for (const inclPath of includeAbsPaths) {
      if (fs.existsSync(inclPath)) {
        const inclFiles = getFilesFromFileSystem(inclPath, summaries, projectRoot, detectedSubKnowledge, excludeAbsPaths);
        files.new.push(...inclFiles.new);
        files.modified.push(...inclFiles.modified);
        files.deleted.push(...inclFiles.deleted);
      }
    }
  } else {
    files = getFilesFromFileSystem(resolvedLocation, summaries, projectRoot, detectedSubKnowledge, excludeAbsPaths);
  }

  files.deleted = [...new Set(files.deleted)];

  if (files.deleted.length > 0) {
    markFilesAsDeleted(files.deleted, summaries, knowledgeDir);
  }

  // Persist any newly detected sub-knowledge refs
  const existingRefKeys = new Set(summaries.subKnowledge.map(r => r.knowledgeDir));
  const newRefs = detectedSubKnowledge.filter(r => !existingRefKeys.has(r.knowledgeDir));
  if (newRefs.length > 0) {
    summaries.subKnowledge.push(...newRefs);
    writeSummaries(knowledgeDir, summaries);
  }

  const unique = [...new Set([...files.new, ...files.modified])];
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
      extensionCountsOfFilesToScan: extCounts,
    },
  };
}
