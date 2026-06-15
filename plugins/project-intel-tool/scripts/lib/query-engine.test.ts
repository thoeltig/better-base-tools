import { describe, it } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import { calculateConfidence, generateQueryOutput, outputToFluentText } from './query-engine.js';
import type { ScoredFileSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScored(overrides: Partial<ScoredFileSummary> & { path: string }): ScoredFileSummary {
  return {
    fileScore: 1,
    sizeChars: 100,
    lineCount: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// calculateConfidence
// ---------------------------------------------------------------------------

describe('calculateConfidence', () => {
  it('returns 0 when no keyword matches anything', () => {
    const score = calculateConfidence(['zzznomatch'], 'src/foo.ts', { summary: 'does stuff' });
    expect(score).toBe(0);
  });

  it('scores a path match', () => {
    const score = calculateConfidence(['auth'], 'src/auth/index.ts', {});
    expect(score).toBeGreaterThan(0);
  });

  it('path match scores less than summary match', () => {
    const pathOnly = calculateConfidence(['auth'], 'src/auth/index.ts', {});
    const summaryOnly = calculateConfidence(['auth'], 'src/other.ts', { summary: 'auth module' });
    expect(summaryOnly).toBeGreaterThan(pathOnly);
  });

  it('scores a summary match', () => {
    const score = calculateConfidence(['scanner'], 'src/foo.ts', { summary: 'scanner for files' });
    expect(score).toBeGreaterThan(0);
  });

  it('scores an exports match', () => {
    const score = calculateConfidence(['parseurl'], 'src/foo.ts', { exports: ['parseUrl', 'formatDate'] });
    expect(score).toBeGreaterThan(0);
  });

  it('scores an imports match on source key', () => {
    const score = calculateConfidence(['zod'], 'src/foo.ts', { imports: { 'zod': ['z'], 'react': ['React'] } });
    expect(score).toBeGreaterThan(0);
  });

  it('scores an imports match on imported name', () => {
    const score = calculateConfidence(['samplingbatch'], 'src/foo.ts', { imports: { 'types.ts': ['SamplingBatch'] } });
    expect(score).toBeGreaterThan(0);
  });

  it('scores a searchTags match', () => {
    const score = calculateConfidence(['token'], 'src/foo.ts', { searchTags: ['token-budget', 'batching'] });
    expect(score).toBeGreaterThan(0);
  });

  it('scores a role match', () => {
    const score = calculateConfidence(['test'], 'src/foo.ts', { role: 'test' });
    expect(score).toBeGreaterThan(0);
  });

  it('scores a technologies match', () => {
    const score = calculateConfidence(['vitest'], 'src/foo.ts', { technologies: ['vitest', 'TypeScript'] });
    expect(score).toBeGreaterThan(0);
  });

  it('accumulates score across multiple matching keywords', () => {
    const single = calculateConfidence(['auth'], 'src/auth.ts', {});
    const multi = calculateConfidence(['auth', 'login'], 'src/auth.ts', { summary: 'handles login' });
    expect(multi).toBeGreaterThan(single);
  });

  it('applies semantic staleness weight — stale summary scores lower', () => {
    const freshScore = calculateConfidence(
      ['scanner'],
      'src/foo.ts',
      { summary: 'scanner module', sizeCharsWhenAnalysed: 1000, sizeChars: 1000 }
    );
    const staleScore = calculateConfidence(
      ['scanner'],
      'src/foo.ts',
      { summary: 'scanner module', sizeCharsWhenAnalysed: 1000, sizeChars: 5000 }
    );
    expect(freshScore).toBeGreaterThan(staleScore);
  });

  it('matching is case-insensitive', () => {
    const lower = calculateConfidence(['auth'], 'src/foo.ts', { summary: 'AUTH module' });
    expect(lower).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateQueryOutput
// ---------------------------------------------------------------------------

describe('generateQueryOutput — flat format', () => {
  it('returns flat results with total', () => {
    const items = [
      makeScored({ path: 'src/a.ts', summary: 'a' }),
      makeScored({ path: 'src/b.ts', summary: 'b' }),
    ];
    const output = generateQueryOutput(items, 'flat', 'full');
    expect(output.total).toBe(2);
    expect(output.results).toHaveLength(2);
    expect(output.grouped).toBeUndefined();
  });

  it('strips internal fields (fileScore, deleted, sizeCharsWhenAnalysed)', () => {
    const items = [makeScored({ path: 'src/a.ts', fileScore: 99 })];
    const output = generateQueryOutput(items, 'flat', 'full');
    const result = output.results?.[0] as any;
    expect(result.fileScore).toBeUndefined();
    expect(result.deleted).toBeUndefined();
    expect(result.sizeCharsWhenAnalysed).toBeUndefined();
  });

  it('structure verbosity omits summary and technologies', () => {
    const items = [makeScored({ path: 'src/a.ts', summary: 'test', technologies: ['ts'] })];
    const output = generateQueryOutput(items, 'flat', 'structure');
    const result = output.results?.[0] as any;
    expect(result.summary).toBeUndefined();
    expect(result.technologies).toBeUndefined();
  });

  it('semantic verbosity omits imports, exports, lineCount, sizeChars', () => {
    const items = [makeScored({ path: 'src/a.ts', imports: { 'zod': ['z'] }, exports: ['foo'], lineCount: 10, sizeChars: 200 })];
    const output = generateQueryOutput(items, 'flat', 'semantic');
    const result = output.results?.[0] as any;
    expect(result.imports).toBeUndefined();
    expect(result.exports).toBeUndefined();
    expect(result.lineCount).toBeUndefined();
    expect(result.sizeChars).toBeUndefined();
  });
});

describe('generateQueryOutput — grouped format', () => {
  it('groups files by folder with total when multiple folders', () => {
    const items = [
      makeScored({ path: 'src/auth/login.ts' }),
      makeScored({ path: 'src/auth/logout.ts' }),
      makeScored({ path: 'src/db/query.ts' }),
    ];
    const output = generateQueryOutput(items, 'grouped', 'full');
    expect(output.total).toBe(3);
    expect(output.grouped).toHaveLength(2);
    expect(output.results).toBeUndefined();
  });

  it('falls back to flat when only one result', () => {
    const items = [makeScored({ path: 'src/auth/login.ts' })];
    const output = generateQueryOutput(items, 'grouped', 'full');
    expect(output.results).toBeDefined();
    expect(output.grouped).toBeUndefined();
  });

  it('falls back to flat when every group has exactly one file', () => {
    const items = [
      makeScored({ path: 'src/auth/login.ts' }),
      makeScored({ path: 'src/db/query.ts' }),
    ];
    const output = generateQueryOutput(items, 'grouped', 'full');
    expect(output.results).toBeDefined();
    expect(output.grouped).toBeUndefined();
  });

  it('groups sort by descending folder score', () => {
    const items = [
      makeScored({ path: 'src/low/a.ts', fileScore: 1 }),
      makeScored({ path: 'src/low/b.ts', fileScore: 1 }),
      makeScored({ path: 'src/high/a.ts', fileScore: 10 }),
      makeScored({ path: 'src/high/b.ts', fileScore: 10 }),
    ];
    const output = generateQueryOutput(items, 'grouped', 'full');
    expect(output.grouped?.[0]?.folderPath).toBe('src/high');
    expect(output.grouped?.[1]?.folderPath).toBe('src/low');
  });

  it('aggregates technologies across files in a group', () => {
    const items = [
      makeScored({ path: 'src/lib/a.ts', technologies: ['TypeScript', 'zod'] }),
      makeScored({ path: 'src/lib/b.ts', technologies: ['TypeScript', 'vitest'] }),
    ];
    const output = generateQueryOutput(items, 'grouped', 'full');
    expect(output.grouped?.[0]?.technologies).toEqual(expect.arrayContaining(['TypeScript', 'zod', 'vitest']));
    // TypeScript appears once (deduped)
    expect(output.grouped?.[0]?.technologies?.filter(t => t === 'TypeScript')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// outputToFluentText
// ---------------------------------------------------------------------------

describe('outputToFluentText', () => {
  it('renders flat results as HTML comment header per file', () => {
    const output = { total: 1, results: [{ path: 'src/a.ts', lineCount: 10, sizeChars: 200, role: 'implementation' as const }] };
    const text = outputToFluentText(output, 'full');
    expect(text).toMatch(/<!-- src\/a\.ts \(Lines: 10, Chars: 200\) \[implementation\] -->/);
  });

  it('renders grouped output with folder header', () => {
    const output = {
      total: 2,
      grouped: [{
        folderPath: 'src/auth',
        files: [
          { fileName: 'login.ts', lineCount: 5, sizeChars: 100 },
          { fileName: 'logout.ts', lineCount: 3, sizeChars: 60 },
        ],
      }],
    };
    const text = outputToFluentText(output, 'full');
    expect(text).toMatch(/<!-- src\/auth -->/);
    expect(text).toContain('login.ts');
    expect(text).toContain('logout.ts');
  });

  it('includes technologies in group header when present', () => {
    const output = {
      grouped: [{
        folderPath: 'src/lib',
        technologies: ['TypeScript', 'vitest'],
        files: [{ fileName: 'a.ts' }],
      }],
    };
    const text = outputToFluentText(output, 'full');
    expect(text).toMatch(/<!-- src\/lib \| TypeScript, vitest -->/);
  });

  it('includes technologies in flat file header when present', () => {
    const output = { results: [{ path: 'src/a.ts', technologies: ['zod'] }] };
    const text = outputToFluentText(output, 'full');
    expect(text).toMatch(/<!-- src\/a\.ts \| zod -->/);
  });

  it('structure verbosity omits summary and analysisDelta', () => {
    const output = { results: [{ path: 'src/a.ts', summary: 'does things', analysisDelta: '+5 lines' }] };
    const text = outputToFluentText(output, 'structure');
    expect(text).not.toContain('does things');
    expect(text).not.toContain('unanalysed');
  });

  it('structure verbosity still includes imports and exports', () => {
    const output = { results: [{ path: 'src/a.ts', imports: { 'zod': ['z'] }, exports: ['parse'] }] };
    const text = outputToFluentText(output, 'structure');
    expect(text).toContain('imports: z from zod');
    expect(text).toContain('exports: parse');
  });

  it('semantic verbosity omits imports, exports, refs', () => {
    const output = { results: [{ path: 'src/a.ts', imports: { 'zod': ['z'] }, exports: ['foo'], refs: ['src/b.ts'], summary: 'hello' }] };
    const text = outputToFluentText(output, 'semantic');
    expect(text).not.toContain('imports:');
    expect(text).not.toContain('exports:');
    expect(text).not.toContain('referenced:');
    expect(text).toContain('hello');
  });

  it('includes summary and analysisDelta in full verbosity', () => {
    const output = { results: [{ path: 'src/a.ts', summary: 'my summary', analysisDelta: '+10 lines +200 chars' }] };
    const text = outputToFluentText(output, 'full');
    expect(text).toContain('my summary');
    expect(text).toContain('unanalysed: +10 lines +200 chars');
  });

  it('does not show technologies in group files (only in folder header)', () => {
    const output = {
      grouped: [{
        folderPath: 'src',
        technologies: ['TypeScript'],
        files: [{ fileName: 'a.ts', technologies: ['TypeScript'] }],
      }],
    };
    const text = outputToFluentText(output, 'full');
    // Folder header has it; file line should not repeat
    const lines = text.split('\n');
    const fileLine = lines.find(l => l.includes('a.ts'));
    expect(fileLine).not.toContain('TypeScript');
  });
});
