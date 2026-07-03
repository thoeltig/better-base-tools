import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { query } from './query-engine.js';
import { KNOWLEDGE_DIRECTORY, SUMMARIES_FILE, SubKnowledgeRef } from '../types.js';

// Integration tests for query()'s cross-knowledge-base aggregation. Each knowledge base is
// written to disk (.knowledge/summaries.json) so query() exercises real reads + recursion.

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agg-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface KB {
  files: Record<string, unknown>;
  subKnowledge?: SubKnowledgeRef[];
}

// Writes a knowledge base rooted at baseDir; returns its .knowledge dir path.
function writeKB(baseDir: string, kb: KB): string {
  const kdir = path.join(baseDir, KNOWLEDGE_DIRECTORY);
  fs.mkdirSync(kdir, { recursive: true });
  const storage = {
    generated: new Date().toISOString(),
    files: kb.files,
    ...(kb.subKnowledge?.length ? { subKnowledge: kb.subKnowledge } : {}),
  };
  fs.writeFileSync(path.join(kdir, SUMMARIES_FILE), JSON.stringify(storage));
  return kdir;
}

function file(summary: string) {
  return { summary, sizeChars: 100, lineCount: 5 };
}

function ref(location: string): SubKnowledgeRef {
  return { location, knowledgeDir: `${location}/${KNOWLEDGE_DIRECTORY}` };
}

function sortedPaths(results: { path: string }[]): string[] {
  return results.map(r => r.path).sort();
}

describe('query — recursive sub-knowledge aggregation', () => {
  it('aggregates nested sub-knowledge recursively via stored refs', () => {
    const topKdir = writeKB(root, { files: { 'a.ts': file('widget top') }, subKnowledge: [ref('subA')] });
    writeKB(path.join(root, 'subA'), { files: { 'b.ts': file('widget subA') }, subKnowledge: [ref('subA1')] });
    writeKB(path.join(root, 'subA', 'subA1'), { files: { 'c.ts': file('widget deep') } });

    const results = query(topKdir, ['widget'], undefined, 50, undefined);
    expect(sortedPaths(results)).toEqual(['a.ts', 'subA/b.ts', 'subA/subA1/c.ts']);
  });

  it('aggregates recursively from an override when no top-level knowledge exists', () => {
    writeKB(path.join(root, 'subA'), { files: { 'b.ts': file('widget subA') }, subKnowledge: [ref('subA1')] });
    writeKB(path.join(root, 'subA', 'subA1'), { files: { 'c.ts': file('widget deep') } });
    writeKB(path.join(root, 'subB'), { files: { 'd.ts': file('widget subB') } });

    const override = [ref('subA'), ref('subB')];
    const nonexistentTop = path.join(root, KNOWLEDGE_DIRECTORY);
    const results = query(nonexistentTop, ['widget'], undefined, 50, undefined, override);
    expect(sortedPaths(results)).toEqual(['subA/b.ts', 'subA/subA1/c.ts', 'subB/d.ts']);
  });

  it('does not loop or double-count on cyclic sub-knowledge refs', () => {
    const topKdir = writeKB(root, { files: { 'a.ts': file('widget') }, subKnowledge: [ref('subA')] });
    // subA points back up to the top knowledge base — must be skipped, not re-scored.
    writeKB(path.join(root, 'subA'), {
      files: { 'b.ts': file('widget') },
      subKnowledge: [{ location: '..', knowledgeDir: `../${KNOWLEDGE_DIRECTORY}` }],
    });

    const results = query(topKdir, ['widget'], undefined, 50, undefined);
    expect(sortedPaths(results)).toEqual(['a.ts', 'subA/b.ts']);
  });

  it('applies scope across nested sub-knowledge levels', () => {
    const topKdir = writeKB(root, { files: { 'a.ts': file('widget') }, subKnowledge: [ref('subA')] });
    writeKB(path.join(root, 'subA'), { files: { 'b.ts': file('widget') }, subKnowledge: [ref('subA1')] });
    writeKB(path.join(root, 'subA', 'subA1'), { files: { 'c.ts': file('widget') } });

    const results = query(topKdir, ['widget'], 'subA/subA1', 50, undefined);
    expect(sortedPaths(results)).toEqual(['subA/subA1/c.ts']);
  });
});
