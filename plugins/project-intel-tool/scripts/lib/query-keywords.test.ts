import { describe, it } from 'node:test';
import { expect } from '../tests/helpers/expect.js';
import { inScope, normalizePathTerm, parseKeywords } from './query-keywords.js';

const ROOT = process.platform === 'win32' ? 'C:\\Work\\Proj' : '/work/proj';
const ROOT_FWD = ROOT.replace(/\\/g, '/');

describe('parseKeywords', () => {
  it('splits on whitespace and lowercases', () => {
    expect(parseKeywords('  Foo   bar\tBAZ ')).toEqual(['foo', 'bar', 'baz']);
  });

  it('keeps a double-quoted term with spaces as one keyword', () => {
    expect(parseKeywords('"My Folder/a.ts" x')).toEqual(['my folder/a.ts', 'x']);
  });

  it('treats an unmatched quote as a normal character boundary', () => {
    expect(parseKeywords('"abc def')).toEqual(['abc', 'def']);
  });

  it('drops empty quoted terms', () => {
    expect(parseKeywords('"" a')).toEqual(['a']);
  });
});

describe('normalizePathTerm', () => {
  it('converts backslashes and collapses duplicate slashes', () => {
    expect(normalizePathTerm('src\\lib\\\\a.ts', ROOT)).toBe('src/lib/a.ts');
  });

  it('strips leading ./ and trailing slash', () => {
    expect(normalizePathTerm('./src/lib/', ROOT)).toBe('src/lib');
  });

  it('makes an absolute path under the root relative, in either slash direction and any case', () => {
    expect(normalizePathTerm(`${ROOT}\\src\\a.ts`, ROOT)).toBe('src/a.ts');
    expect(normalizePathTerm(`${ROOT_FWD.toUpperCase()}/src/a.ts`, ROOT)).toBe('src/a.ts');
  });

  it('the root itself normalizes to an empty term', () => {
    expect(normalizePathTerm(`${ROOT}\\`, ROOT)).toBe('');
  });

  it('does not strip a root that is only a text prefix of another folder', () => {
    expect(normalizePathTerm(`${ROOT_FWD}2/a.ts`, ROOT)).toBe(`${ROOT_FWD}2/a.ts`.toLowerCase());
  });

  it('leaves plain words unchanged', () => {
    expect(normalizePathTerm('auth', ROOT)).toBe('auth');
  });
});

describe('inScope', () => {
  it('matches files under the folder on a segment boundary', () => {
    expect(inScope('src/a.ts', 'src')).toBe(true);
    expect(inScope('src2/a.ts', 'src')).toBe(false);
  });

  it('ignores case', () => {
    expect(inScope('Src/Lib/A.ts', 'src/lib')).toBe(true);
  });

  it('an empty scope matches everything', () => {
    expect(inScope('a.ts', '')).toBe(true);
  });
});
