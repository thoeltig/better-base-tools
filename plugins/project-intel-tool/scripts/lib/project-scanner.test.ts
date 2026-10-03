import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { discoverSubKnowledge, scanProject } from './project-scanner.js';
import { getOrCreateSummaries, toAbsReal } from './summary-merger.js';
import { releaseLock } from './lock.js';
import { DEFAULT_SCAN_CONFIG, FileSummary, KNOWLEDGE_DIRECTORY, SUMMARIES_FILE } from '../types.js';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-disc-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeKnowledge(dir: string): void {
  const kdir = path.join(dir, KNOWLEDGE_DIRECTORY);
  fs.mkdirSync(kdir, { recursive: true });
  fs.writeFileSync(path.join(kdir, SUMMARIES_FILE), JSON.stringify({ generated: '', files: {} }));
}

function makeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x');
}

describe('discoverSubKnowledge', () => {
  it('finds direct boundary knowledge dirs without descending into them', () => {
    makeKnowledge(path.join(root, 'subA'));
    makeKnowledge(path.join(root, 'subA', 'subA1')); // grandchild — must NOT be returned
    makeKnowledge(path.join(root, 'subB'));
    makeFile(path.join(root, 'plain', 'x.ts'));

    const refs = discoverSubKnowledge(root, root);
    expect(refs.map(r => r.location).sort()).toEqual(['subA', 'subB']);
  });

  it('records knowledgeDir relative to the project root with forward slashes', () => {
    makeKnowledge(path.join(root, 'subA'));
    const refs = discoverSubKnowledge(root, root);
    expect(refs.find(r => r.location === 'subA')?.knowledgeDir).toBe(`subA/${KNOWLEDGE_DIRECTORY}`);
  });

  it('ignores build/dependency directories', () => {
    makeKnowledge(path.join(root, 'node_modules', 'pkg'));
    makeKnowledge(path.join(root, 'realsub'));
    const refs = discoverSubKnowledge(root, root);
    expect(refs.map(r => r.location)).toEqual(['realsub']);
  });

  it('respects excludeAbsPaths', () => {
    makeKnowledge(path.join(root, 'subA'));
    makeKnowledge(path.join(root, 'subB'));
    const refs = discoverSubKnowledge(root, root, [path.join(root, 'subB')]);
    expect(refs.map(r => r.location)).toEqual(['subA']);
  });

  it('returns empty when no sub-knowledge exists', () => {
    makeFile(path.join(root, 'src', 'index.ts'));
    expect(discoverSubKnowledge(root, root)).toEqual([]);
  });
});

describe('scanProject', () => {
  let originalCwd: string;
  let originalCeiling: string | undefined;
  let kdir: string;

  // scanProject picks git or file-system discovery from the process cwd
  beforeEach(() => {
    originalCwd = process.cwd();
    originalCeiling = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = path.dirname(root);
    process.chdir(root);
    kdir = path.join(root, KNOWLEDGE_DIRECTORY);
  });

  afterEach(() => {
    releaseLock();
    process.chdir(originalCwd);
    if (originalCeiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
    else process.env['GIT_CEILING_DIRECTORIES'] = originalCeiling;
  });

  function writeSummariesFile(files: Record<string, FileSummary>): void {
    fs.mkdirSync(kdir, { recursive: true });
    fs.writeFileSync(path.join(kdir, SUMMARIES_FILE), JSON.stringify({ generated: '', files }));
  }

  const staleEntry: FileSummary = {
    summary: 'kept',
    exports: ['removedExport'],
    imports: { 'b.ts': ['x'] },
    refs: ['b.ts'],
    sizeCharsWhenAnalysed: 1000,
    lineCountWhenAnalysed: 100,
    analysisDelta: 'stale delta',
    lastUpdated: '2000-01-01T00:00:00.000Z',
  };

  it('drops structural fields of a changed file that no longer has them', async () => {
    writeSummariesFile({ 'a.ts': staleEntry });
    fs.writeFileSync(path.join(root, 'a.ts'), 'const local = 1;\n');

    await scanProject(root, kdir, DEFAULT_SCAN_CONFIG);

    const entry = getOrCreateSummaries(kdir, root).files.get(toAbsReal(root, 'a.ts'));
    expect(entry?.summary).toBe('kept');
    expect(entry?.exports).toBeUndefined();
    expect(entry?.imports).toBeUndefined();
    expect(entry?.refs).toBeUndefined();
    expect(entry?.analysisDelta).not.toBe('stale delta');
  });

  it('releases the summaries lock after scanning', async () => {
    writeSummariesFile({ 'a.ts': staleEntry });
    fs.writeFileSync(path.join(root, 'a.ts'), 'x');

    await scanProject(root, kdir, DEFAULT_SCAN_CONFIG);

    expect(fs.existsSync(path.join(kdir, 'summaries.lock'))).toBe(false);
  });

  it('rejects without writing when another live process holds the lock', { timeout: 3000 }, async () => {
    writeSummariesFile({ 'a.ts': staleEntry });
    fs.writeFileSync(path.join(root, 'a.ts'), 'x');
    const lockPath = path.join(kdir, 'summaries.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));

    await assert.rejects(scanProject(root, kdir, DEFAULT_SCAN_CONFIG, 300), /not released within 300ms/);

    expect(fs.existsSync(lockPath)).toBe(true);
    const entry = getOrCreateSummaries(kdir, root).files.get(toAbsReal(root, 'a.ts'));
    expect(entry?.exports).toEqual(['removedExport']);
  });
});
