import { describe, it, beforeEach, afterEach } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverSubKnowledge } from './project-scanner.js';
import { KNOWLEDGE_DIRECTORY, SUMMARIES_FILE } from '../types.js';

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
