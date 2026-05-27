import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getOrCreateSummaries, writeSummaries } from './summary-merger';
import { KNOWLEDGE_DIRECTORY, SUMMARIES_FILE, SummariesData } from '../types';

export interface ScanResult {
  filesToScan: string[][];
  projectStats: {
    knowledgeDir: string;
    totalFilesInKnowledge: number;
    numberOfFilesToScan: number;
    extensionCountsOfFilesToScan: Record<string,number>;
  };
}

interface Files{
  new: string[];
  modified: string[];
  deleted: string[];
}

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '__pycache__', 'target', 'bin', 'obj', 
  '.git', '.svn', 'coverage', '.pytest_cache', '.venv', 'venv', '.env', '.idea', 
  '.meteor', '.angular', '.vscode', '.vs', 'vendor', 'tmp', '.cache', KNOWLEDGE_DIRECTORY, '.claude', 
]);

function shouldIgnore(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function trimToProjectDirFromFilepath(filepath: string, projectRoot:string): string{
  // Normalize to forward slashes for consistency across platforms (git uses forward slashes)
  return path.relative(projectRoot, filepath).replace(/\\/g, '/');
}

function searchFileSystemRecursive(dir: string): string | undefined {  
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const dirPath = path.join(dir, entry);
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory()) {        
        if (entry === KNOWLEDGE_DIRECTORY) {
          const fullPath = path.join(dirPath, SUMMARIES_FILE);
          if(fs.existsSync(fullPath)) {
            return path.normalize(fullPath);
          }
        }
        
        const result = searchFileSystemRecursive(dirPath);
        if(result) {
          return result;
        }
      }
    }
  } catch {}

  return undefined;
}

function getSummaryFiles(summaries: SummariesData): Map<string, Date>{
  const mapOfSummaryFileEntries = new Map<string, Date>();

  // Check for a summary if one exist filepaths can be further reduced to only the actually modified files since last scan
  if(summaries.files.size === 0){
    // No Summary = initial scan so return all tracked files
    return mapOfSummaryFileEntries;
  }

  // Find oldest scan date and create look for filepath and date
  summaries.files
    .forEach((val, key) => { 
      const dateString = val.lastUpdated;
      const lastUpdate = dateString ? new Date(dateString) : new Date();
      mapOfSummaryFileEntries.set(key, lastUpdate);
    });
    
  return mapOfSummaryFileEntries;
}

function getGitTrackedFiles(location: string): string[]{  
  // Get git tracked files in this location
  const trackedFiles = execSync(`git ls-files --full-name -- "${location}"`, { encoding: 'utf-8' })
    .trim()
    .split('\n');

  // Filter out the build, obj, cache, etc directorie and .claude/.knowledge directory
  const filteredTrackedFiles = trackedFiles
    .filter(f => {
      const segments = f.split('/');
      return !segments.some(x => shouldIgnore(x));
    })
    .map(x => path.join(location, x));

  return filteredTrackedFiles;
}

function isGitRepository(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getFilesFromGit(location: string, summaries: SummariesData, projectRoot: string): Files{
  const files:Files = {
    new: [],
    modified: [],
    deleted: []
  };

  try {
    // Get git tracked files in this location
    const trackedFiles = getGitTrackedFiles(location);
    
    // Check for a summary if one exist filepaths can be further reduced to only the actually modified files since last scan    
    const mapOfSummaryFileEntries = getSummaryFiles(summaries);
    if(mapOfSummaryFileEntries.size === 0){
      // No Summary = initial scan so return all tracked files
      trackedFiles.forEach(filepath => files.new.push(trimToProjectDirFromFilepath(filepath, projectRoot)));
      return files;
    }
        
    // Find oldest scan date and create look for filepath and date
    let since = new Date();
    mapOfSummaryFileEntries.forEach(x => {
      if(x < since) since = x;
    });
    
    // Get git log since the last update to check if the git modified date is newer then the correlating file last scan date
    const output = execSync(`git log --format=%ai --name-only --since="${since.toISOString()}" -- "${location}"`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n');

    const modifiedFileMap = new Map<string, Date>();
    let currentDate: Date | null = null;

    for (const line of lines) {
      if (!line) continue;

      // Check if this is a date line (ISO format)
      if (line.match(/^\d{4}-\d{2}-\d{2}/)) {
        currentDate = new Date(line);
      } else if (currentDate && line && !line.split('/').some(x => shouldIgnore(x))) {
        // Only add if we haven't seen it yet (first = most recent)
        const lastUpdated = mapOfSummaryFileEntries.get(line);
        const filepath = path.join(location, line);
        const relativePath = trimToProjectDirFromFilepath(filepath, projectRoot);
        if ((!lastUpdated || lastUpdated < currentDate) && !modifiedFileMap.has(relativePath) && fs.existsSync(filepath)) {
          modifiedFileMap.set(relativePath, currentDate);
        }
      }
    }
        
    trackedFiles.forEach(x => {
      const relativePath = trimToProjectDirFromFilepath(x, projectRoot);
      const founDate = mapOfSummaryFileEntries.get(relativePath);
      if(!founDate){
        files.new.push(relativePath);
      }
    });

    const set = new Set<string>(trackedFiles);
    mapOfSummaryFileEntries.forEach((_,relativePath) => {
      const filepath = path.join(projectRoot, relativePath);
      if(filepath.startsWith(location) && set.has(filepath) === false){
        files.deleted.push(relativePath);
      }
    });

    files.modified.push(...modifiedFileMap.keys());
    return files;
  } catch { 
    return files;
  }
}

function getFilesFromFileSystem(location: string, summaries: SummariesData, projectRoot: string): Files{
  const files:Files = {
    new: [],
    modified: [],
    deleted: []
  };

   try { 
    const filepathesInThisLocation = new Map<string, Date>();
    getFilesFromFileSystemRecursive(location, location, filepathesInThisLocation);
      
    const mapOfSummaryFileEntries = getSummaryFiles(summaries);
    if(mapOfSummaryFileEntries.size == 0){      
      // No Summary = initial scan so return all tracked files
      filepathesInThisLocation.forEach((_, filepath) => files.new.push(trimToProjectDirFromFilepath(filepath, projectRoot)));
      return files;
    }
        
    filepathesInThisLocation.forEach((currentDate, filepath) => {      
      const relativePath = trimToProjectDirFromFilepath(filepath, projectRoot);
      const lastDate = mapOfSummaryFileEntries.get(relativePath);
      if(!lastDate){
        files.new.push(relativePath);
      }else if(currentDate > lastDate){
        files.modified.push(relativePath);
      }
    });

    mapOfSummaryFileEntries.forEach((_, relativePath) => {
      const filepath = path.join(projectRoot, relativePath);
      if(filepath.startsWith(location) && !filepathesInThisLocation.get(filepath)){
        files.deleted.push(relativePath);
      }
    });

    return files;
  } catch {
    return files;
  }
}

function getFilesFromFileSystemRecursive(dir: string, rootDir: string, filePaths: Map<string,Date>): void {   
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (shouldIgnore(entry)) {
        continue;
      }

      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        getFilesFromFileSystemRecursive(fullPath, rootDir, filePaths);
      } else if (stat.isFile()) {
        filePaths.set(fullPath, stat.mtime);
      }
    }
  } catch (e) {}
}

function deletedOldEntriesFromKnowledge(filePaths: string[], summaries: SummariesData, knowledgeDir: string): number{
  const directoryDeleteCandidates = new Set<string>();
  filePaths.forEach(x => {
    directoryDeleteCandidates.add(path.dirname(x));
    summaries.files.delete(x);
  });

  const fileKeys = [...summaries.files.keys()];
  const remainingDictionariesInFiles = new Set<string>(fileKeys.map(x => path.dirname(x)));
  directoryDeleteCandidates.forEach(x => {
    if(remainingDictionariesInFiles.has(x) === false){
      summaries.directories.delete(x);
    }
  });

  writeSummaries(knowledgeDir, summaries);
  return fileKeys.length;
}

function getExtensionCounts(filePaths: string[]): Record<string, number>{
  return filePaths.reduce(
    (acc, file) => {
      const ext = path.extname(file).toLowerCase() || 'none';
      acc[ext] = (acc[ext] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
}

function batchFiles(filePaths: string[], batchSize: number = 8): string[][] {
  // TODO: Optimize batching by directory to avoid duplicate directory summaries across agents
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += batchSize) {
    batches.push(filePaths.slice(i, i + batchSize));
  }
  return batches;
}

function createOutput(filePaths: string[], filesInSummary: number, knowledgeDir: string): ScanResult{
  return {
    filesToScan: batchFiles(filePaths),
    projectStats: {
      knowledgeDir: knowledgeDir,
      totalFilesInKnowledge: filesInSummary,
      numberOfFilesToScan: filePaths.length,
      extensionCountsOfFilesToScan: getExtensionCounts(filePaths)
    }
  };
}

export function findKnowledgeDir(location: string): string | undefined {
  if (isGitRepository()) {
    try {
      const fileLocation = path.join(KNOWLEDGE_DIRECTORY, SUMMARIES_FILE);
      const foundKnowledgeFile = execSync(`git ls-files --full-name -- "${location}"`, { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .find(f => f.endsWith(fileLocation));

      if(foundKnowledgeFile){
        return path.normalize(path.dirname(path.join(location, foundKnowledgeFile)));
      }
    } catch { }
  }

  const foundFile = searchFileSystemRecursive(location);
  return foundFile ? path.dirname(foundFile) : undefined;
}

export async function scanProject(location: string, knowledgeDir: string): Promise<ScanResult> {
  const summaries = getOrCreateSummaries(knowledgeDir);
  let filesInSummary = summaries.files.size;

  if (!fs.existsSync(location)) {
    return createOutput([], filesInSummary, knowledgeDir);
  }

  const projectRoot = path.dirname(knowledgeDir);

  let files: Files;
  if(isGitRepository()){
    files = getFilesFromGit(location, summaries, projectRoot);
  }
  else{
    files = getFilesFromFileSystem(location, summaries, projectRoot);
  }

  if(files.deleted.length !== 0){
    filesInSummary = deletedOldEntriesFromKnowledge(files.deleted, summaries, knowledgeDir);
  }

  const uniqueFiles = [...new Set<string>([...files.new, ...files.modified])];
  return createOutput(uniqueFiles, filesInSummary, knowledgeDir);
}