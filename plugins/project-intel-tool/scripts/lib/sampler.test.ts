import { describe, it, expect } from 'vitest';
import { buildSamplingBatches } from './sampler.js';
import { toAbsReal } from './summary-merger.js';
import type { FileRefs } from './file-map.js';
import type { SummariesData } from '../types.js';

const TEST_ROOT = '.';
const abs = (p: string) => toAbsReal(TEST_ROOT, p);

function makeFileRefs(overrides: Partial<FileRefs> = {}): FileRefs {
  return { imports: {}, exports: [], refs: [], sizeChars: 1000, lineCount: 40, ...overrides };
}

function emptySummaries(): SummariesData {
  return {
    generated: new Date().toISOString(),
    files: new Map(),
    subKnowledge: [],
  };
}

describe('buildSamplingBatches — ordering', () => {
  it('files with no deps are placed in the first batch', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const fileMap = new Map([
      ['a.ts', makeFileRefs()],
      ['b.ts', makeFileRefs()],
      ['c.ts', makeFileRefs()],
    ]);
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    expect(batches).toHaveLength(1);
    expect(batches[0]?.files).toEqual(expect.arrayContaining(['a.ts', 'b.ts', 'c.ts']));
  });

  it('dependent file appears after its dependency within the same batch', () => {
    // a.ts refs b.ts → cohesion groups them together, b.ts ordered first (dep-first)
    const files = ['a.ts', 'b.ts'];
    const fileMap = new Map([
      ['a.ts', makeFileRefs({ refs: ['b.ts'], sizeChars: 8_000 })],
      ['b.ts', makeFileRefs({ sizeChars: 8_000 })],
    ]);
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.files.indexOf('b.ts')).toBeLessThan(batch.files.indexOf('a.ts'));
  });

  it('handles a chain A → B → C: all cohesion-grouped, ordered C then B then A', () => {
    // Cohesion merges the whole chain into one component; topo-sort orders deps first
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const fileMap = new Map([
      ['a.ts', makeFileRefs({ refs: ['b.ts'], sizeChars: 8_000 })],
      ['b.ts', makeFileRefs({ refs: ['c.ts'], sizeChars: 8_000 })],
      ['c.ts', makeFileRefs({ sizeChars: 8_000 })],
    ]);
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    const posC = batch.files.indexOf('c.ts');
    const posB = batch.files.indexOf('b.ts');
    const posA = batch.files.indexOf('a.ts');
    expect(posC).toBeLessThan(posB);
    expect(posB).toBeLessThan(posA);
  });

  it('handles circular dependencies without infinite loop', () => {
    const files = ['a.ts', 'b.ts'];
    const fileMap = new Map([
      ['a.ts', makeFileRefs({ refs: ['b.ts'] })],
      ['b.ts', makeFileRefs({ refs: ['a.ts'] })],
    ]);
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    const allFiles = batches.flatMap(b => b.files);
    expect(allFiles).toContain('a.ts');
    expect(allFiles).toContain('b.ts');
  });

  it('excludes already-summarized files from scan set deps', () => {
    // b.ts is already summarized — a.ts imports it but b.ts is not in filesToScan
    const files = ['a.ts'];
    const fileMap = new Map([['a.ts', makeFileRefs({ refs: ['b.ts'] })]]);
    const summaries = emptySummaries();
    summaries.files.set('b.ts', { summary: 'existing summary', lastUpdated: new Date().toISOString() });

    const batches = buildSamplingBatches(files, fileMap, summaries);
    // a.ts has no intra-scan deps, so it can go in layer 0
    expect(batches).toHaveLength(1);
    expect(batches[0]?.files).toContain('a.ts');
  });
});

describe('buildSamplingBatches — context files', () => {
  it('includes summary of already-summarized dep as context', () => {
    const files = ['a.ts'];
    const fileMap = new Map([['a.ts', makeFileRefs({ refs: ['b.ts'] })]]);
    const summaries = emptySummaries();
    summaries.files.set(abs('b.ts'), { summary: 'B does something useful', lastUpdated: new Date().toISOString() });

    const batches = buildSamplingBatches(files, fileMap, summaries, undefined, TEST_ROOT);
    const ctx = batches[0]?.contextFiles ?? [];
    expect(ctx.some(c => c.path === 'b.ts' && c.summary === 'B does something useful')).toBe(true);
  });

  it('does not include deleted files as context', () => {
    const files = ['a.ts'];
    const fileMap = new Map([['a.ts', makeFileRefs({ refs: ['b.ts'] })]]);
    const summaries = emptySummaries();
    summaries.files.set(abs('b.ts'), { summary: 'B summary', deleted: true, lastUpdated: new Date().toISOString() });

    const batches = buildSamplingBatches(files, fileMap, summaries, undefined, TEST_ROOT);
    const ctx = batches[0]?.contextFiles ?? [];
    expect(ctx.some(c => c.path === 'b.ts')).toBe(false);
  });
});

describe('buildSamplingBatches — token budget', () => {
  it('splits files into multiple batches when budget is exceeded', () => {
    // Each file is ~240k chars ≈ 60k tokens, exceeding the 60k budget alone
    const bigContent = makeFileRefs({ sizeChars: 240_000, lineCount: 5000 });
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const fileMap = new Map([
      ['a.ts', bigContent],
      ['b.ts', bigContent],
      ['c.ts', bigContent],
    ]);
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    // Each file exceeds budget on its own so each gets its own batch
    expect(batches.length).toBeGreaterThanOrEqual(3);
  });

  it('groups small files together within budget', () => {
    // 100 small files ~1k chars each ≈ 250 tokens each, well under 60k budget
    const smallContent = makeFileRefs({ sizeChars: 1000, lineCount: 30 });
    const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
    const fileMap = new Map(files.map(f => [f, smallContent]));
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    // 20 files at ~250 tokens each = ~5k total, should fit in 1 batch
    expect(batches.length).toBe(1);
    expect(batches[0]?.files).toHaveLength(20);
  });

  it('every file in filesToScan appears in exactly one batch', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const fileMap = new Map([
      ['a.ts', makeFileRefs({ refs: ['b.ts'] })],
      ['b.ts', makeFileRefs({ refs: ['c.ts'] })],
      ['c.ts', makeFileRefs()],
      ['d.ts', makeFileRefs()],
    ]);
    const batches = buildSamplingBatches(files, fileMap, emptySummaries());
    const allFiles = batches.flatMap(b => b.files);
    expect(allFiles.sort()).toEqual([...files].sort());
    // No duplicates
    expect(new Set(allFiles).size).toBe(allFiles.length);
  });
});
