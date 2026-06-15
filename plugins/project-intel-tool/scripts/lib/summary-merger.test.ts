import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getOrCreateSummaries,
  writeSummaries,
  mergeSamplingResults,
  markFilesAsDeleted,
  toAbsReal,
} from './summary-merger.js';
import type { SummariesData } from '../types.js';

let tmpDir: string;
let projectRoot: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-intel-test-'));
  projectRoot = path.dirname(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const abs = (rel: string) => toAbsReal(projectRoot, rel);

function readStoredJson() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'summaries.json'), 'utf-8'));
}

describe('getOrCreateSummaries', () => {
  it('normalizes ./ prefix keys to abs real paths on load', () => {
    const stored = {
      generated: '2024-01-01T00:00:00.000Z',
      files: { './src/file.ts': { summary: 'has prefix', lastUpdated: '2024-01-01T00:00:00.000Z' } },
    };
    fs.writeFileSync(path.join(tmpDir, 'summaries.json'), JSON.stringify(stored));
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.has('./src/file.ts')).toBe(false);
    expect(data.files.get(abs('src/file.ts'))?.summary).toBe('has prefix');
  });

  it('normalizes backslash paths to abs real paths on load', () => {
    const stored = {
      generated: '2024-01-01T00:00:00.000Z',
      files: { 'src\\sub\\file.ts': { summary: 'backslash path', lastUpdated: '2024-01-01T00:00:00.000Z' } },
    };
    fs.writeFileSync(path.join(tmpDir, 'summaries.json'), JSON.stringify(stored));
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.has('src\\sub\\file.ts')).toBe(false);
    expect(data.files.get(abs('src/sub/file.ts'))?.summary).toBe('backslash path');
  });

  it('on key collision keeps non-deleted over deleted', () => {
    const stored = {
      generated: '2024-01-01T00:00:00.000Z',
      files: {
        './src/a.ts': { summary: 'deleted version', deleted: true, lastUpdated: '2024-06-01T00:00:00.000Z' },
        'src/a.ts': { summary: 'live version', deleted: false, lastUpdated: '2024-01-01T00:00:00.000Z' },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'summaries.json'), JSON.stringify(stored));
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.size).toBe(1);
    expect(data.files.get(abs('src/a.ts'))?.deleted).toBe(false);
    expect(data.files.get(abs('src/a.ts'))?.summary).toBe('live version');
  });

  it('on key collision keeps more recent lastUpdated when both non-deleted', () => {
    const stored = {
      generated: '2024-01-01T00:00:00.000Z',
      files: {
        './src/b.ts': { summary: 'newer', deleted: false, lastUpdated: '2024-06-01T00:00:00.000Z' },
        'src/b.ts': { summary: 'older', deleted: false, lastUpdated: '2024-01-01T00:00:00.000Z' },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'summaries.json'), JSON.stringify(stored));
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.size).toBe(1);
    expect(data.files.get(abs('src/b.ts'))?.summary).toBe('newer');
  });

  it('returns empty data when no summaries file exists', () => {
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.size).toBe(0);
    expect(data.subKnowledge).toEqual([]);
  });

  it('reads and deserialises existing summaries file', () => {
    const stored = {
      generated: '2024-01-01T00:00:00.000Z',
      files: { 'src/auth/index.ts': { summary: 'auth entry', role: 'implementation' } },
      subKnowledge: [{ location: 'packages/ui', knowledgeDir: 'packages/ui/.knowledge' }],
    };
    fs.writeFileSync(path.join(tmpDir, 'summaries.json'), JSON.stringify(stored));

    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.get(abs('src/auth/index.ts'))?.summary).toBe('auth entry');
    expect(data.subKnowledge).toHaveLength(1);
    expect(data.subKnowledge[0]?.location).toBe('packages/ui');
  });

  it('returns empty data when summaries file is corrupt', () => {
    fs.writeFileSync(path.join(tmpDir, 'summaries.json'), 'not valid json{{{');
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.size).toBe(0);
  });
});

describe('writeSummaries', () => {
  it('writes pretty-printed JSON with 2-space indent', () => {
    const data: SummariesData = {
      generated: '2024-01-01T00:00:00.000Z',
      files: new Map([[abs('src/a.ts'), { summary: 'file a' }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, data, projectRoot);
    const raw = fs.readFileSync(path.join(tmpDir, 'summaries.json'), 'utf-8');
    expect(raw).toMatch(/\n/);
    expect(raw).toMatch(/  /);
  });

  it('stores relative keys in JSON', () => {
    const data: SummariesData = {
      generated: '2024-01-01T00:00:00.000Z',
      files: new Map([[abs('src/a.ts'), { summary: 'file a' }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, data, projectRoot);
    const stored = readStoredJson();
    expect(Object.keys(stored.files)).toEqual(['src/a.ts']);
  });

  it('round-trips through getOrCreateSummaries', () => {
    const data: SummariesData = {
      generated: '2024-01-01T00:00:00.000Z',
      files: new Map([[abs('src/b.ts'), { summary: 'b file', role: 'test', sizeChars: 500, lineCount: 20 }]]),
      subKnowledge: [{ location: 'sub', knowledgeDir: 'sub/.knowledge' }],
    };
    writeSummaries(tmpDir, data, projectRoot);
    const read = getOrCreateSummaries(tmpDir, projectRoot);
    expect(read.files.get(abs('src/b.ts'))?.summary).toBe('b file');
    expect(read.files.get(abs('src/b.ts'))?.sizeChars).toBe(500);
    expect(read.subKnowledge[0]?.location).toBe('sub');
  });

  it('omits subKnowledge key when array is empty', () => {
    const data: SummariesData = {
      generated: '2024-01-01T00:00:00.000Z',
      files: new Map(),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, data, projectRoot);
    const stored = readStoredJson();
    expect('subKnowledge' in stored).toBe(false);
  });

  it('sorts files by path for stable git diffs', () => {
    const data: SummariesData = {
      generated: '2024-01-01T00:00:00.000Z',
      files: new Map([[abs('src/z.ts'), { summary: 'z' }], [abs('src/a.ts'), { summary: 'a' }], [abs('src/m.ts'), { summary: 'm' }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, data, projectRoot);
    const stored = readStoredJson();
    expect(Object.keys(stored.files)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });
});

describe('mergeSamplingResults', () => {
  it('inserts new file entries', () => {
    mergeSamplingResults(tmpDir, [
      { path: 'src/foo.ts', summary: 'foo file', role: 'implementation' },
    ], projectRoot);
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.get(abs('src/foo.ts'))?.summary).toBe('foo file');
    expect(data.files.get(abs('src/foo.ts'))?.role).toBe('implementation');
  });

  it('stores files sorted by path in JSON', () => {
    mergeSamplingResults(tmpDir, [
      { path: 'src/z.ts', summary: 'z' },
      { path: 'src/a.ts', summary: 'a' },
    ], projectRoot);
    const stored = readStoredJson();
    expect(Object.keys(stored.files)).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('updates an existing entry and sets lastUpdated', () => {
    mergeSamplingResults(tmpDir, [{ path: 'src/a.ts', summary: 'old' }], projectRoot);
    mergeSamplingResults(tmpDir, [{ path: 'src/a.ts', summary: 'new', role: 'test' }], projectRoot);
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    const entry = data.files.get(abs('src/a.ts'));
    expect(entry?.summary).toBe('new');
    expect(entry?.role).toBe('test');
    expect(entry?.lastUpdated).toBeTruthy();
  });

  it('clears the deleted flag when a file is re-scanned', () => {
    const initial: SummariesData = {
      generated: new Date().toISOString(),
      files: new Map([[abs('src/a.ts'), { summary: 'old', deleted: true }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, initial, projectRoot);

    mergeSamplingResults(tmpDir, [{ path: 'src/a.ts', summary: 'revived' }], projectRoot);
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.get(abs('src/a.ts'))?.deleted).toBe(false);
    expect(data.files.get(abs('src/a.ts'))?.summary).toBe('revived');
  });

  it('preserves existing fields not included in sampling result', () => {
    const initial: SummariesData = {
      generated: new Date().toISOString(),
      files: new Map([[abs('src/a.ts'), { summary: 'original', sizeChars: 999, refs: ['src/b.ts'] }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, initial, projectRoot);

    mergeSamplingResults(tmpDir, [{ path: 'src/a.ts', summary: 'updated' }], projectRoot);
    const data = getOrCreateSummaries(tmpDir, projectRoot);
    const entry = data.files.get(abs('src/a.ts'));
    expect(entry?.summary).toBe('updated');
    expect(entry?.sizeChars).toBe(999);
    expect(entry?.refs).toEqual(['src/b.ts']);
  });
});

describe('markFilesAsDeleted', () => {
  it('sets deleted flag without removing the entry', () => {
    const initial: SummariesData = {
      generated: new Date().toISOString(),
      files: new Map([[abs('src/a.ts'), { summary: 'a file' }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, initial, projectRoot);

    const summaries = getOrCreateSummaries(tmpDir, projectRoot);
    markFilesAsDeleted([abs('src/a.ts')], summaries, tmpDir, projectRoot);

    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.has(abs('src/a.ts'))).toBe(true);
    expect(data.files.get(abs('src/a.ts'))?.deleted).toBe(true);
    expect(data.files.get(abs('src/a.ts'))?.summary).toBe('a file');
  });

  it('preserves all other fields when marking deleted', () => {
    const initial: SummariesData = {
      generated: new Date().toISOString(),
      files: new Map([[abs('src/b.ts'), { summary: 'b file', role: 'implementation', exports: ['foo'] }]]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, initial, projectRoot);

    const summaries = getOrCreateSummaries(tmpDir, projectRoot);
    markFilesAsDeleted([abs('src/b.ts')], summaries, tmpDir, projectRoot);

    const entry = getOrCreateSummaries(tmpDir, projectRoot).files.get(abs('src/b.ts'));
    expect(entry?.role).toBe('implementation');
    expect(entry?.exports).toEqual(['foo']);
  });

  it('silently ignores files not in summaries', () => {
    const summaries = getOrCreateSummaries(tmpDir, projectRoot);
    expect(() => markFilesAsDeleted([abs('nonexistent.ts')], summaries, tmpDir, projectRoot)).not.toThrow();
  });

  it('marks multiple files deleted in one call', () => {
    const initial: SummariesData = {
      generated: new Date().toISOString(),
      files: new Map([
        [abs('src/a.ts'), { summary: 'a' }],
        [abs('src/b.ts'), { summary: 'b' }],
        [abs('src/c.ts'), { summary: 'c' }],
      ]),
      subKnowledge: [],
    };
    writeSummaries(tmpDir, initial, projectRoot);

    const summaries = getOrCreateSummaries(tmpDir, projectRoot);
    markFilesAsDeleted([abs('src/a.ts'), abs('src/c.ts')], summaries, tmpDir, projectRoot);

    const data = getOrCreateSummaries(tmpDir, projectRoot);
    expect(data.files.get(abs('src/a.ts'))?.deleted).toBe(true);
    expect(data.files.get(abs('src/b.ts'))?.deleted).toBeUndefined();
    expect(data.files.get(abs('src/c.ts'))?.deleted).toBe(true);
  });
});
