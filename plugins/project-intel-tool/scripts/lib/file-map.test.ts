import { describe, it, expect } from 'vitest';
import { parseFileRefs } from './file-map.js';

const ROOT = '/project';

function makeSet(...files: string[]) {
  return new Set(files);
}

describe('parseFileRefs — TS/JS', () => {
  it('resolves relative import with .ts extension lookup', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { foo } from './utils'`,
      makeSet('src/main.ts', 'src/utils.ts'),
      ROOT
    );
    expect(result.imports).toEqual(['src/utils.ts']);
    expect(result.refs).toContain('src/utils.ts');
  });

  it('resolves relative import via index.ts fallback', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { x } from './services/auth'`,
      makeSet('src/main.ts', 'src/services/auth/index.ts'),
      ROOT
    );
    expect(result.imports).toContain('src/services/auth/index.ts');
  });

  it('resolves parent directory import', () => {
    const result = parseFileRefs(
      'src/features/login.ts',
      `import { helper } from '../shared/helper'`,
      makeSet('src/features/login.ts', 'src/shared/helper.ts'),
      ROOT
    );
    expect(result.imports).toContain('src/shared/helper.ts');
  });

  it('ignores external package imports', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import React from 'react';
import { z } from 'zod';`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(result.imports).toHaveLength(0);
  });

  it('ignores import not found in project file set', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { x } from './missing'`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(result.imports).toHaveLength(0);
  });

  it('extracts named exports from export declarations', () => {
    const result = parseFileRefs(
      'src/utils.ts',
      `export const formatDate = () => {};
export function parseUrl(url: string) {}
export class UserService {}
export interface Config {}
export type UserId = string;`,
      makeSet('src/utils.ts'),
      ROOT
    );
    expect(result.exports).toContain('formatDate');
    expect(result.exports).toContain('parseUrl');
    expect(result.exports).toContain('UserService');
    expect(result.exports).toContain('Config');
    expect(result.exports).toContain('UserId');
  });

  it('extracts brace-style re-exports', () => {
    const result = parseFileRefs(
      'src/index.ts',
      `export { UserService, parseUrl as parse }`,
      makeSet('src/index.ts'),
      ROOT
    );
    expect(result.exports).toContain('UserService');
    expect(result.exports).toContain('parseUrl');
    expect(result.exports).not.toContain('parse'); // alias excluded
  });

  it('handles require() calls', () => {
    const result = parseFileRefs(
      'src/legacy.js',
      `const utils = require('./utils')`,
      makeSet('src/legacy.js', 'src/utils.ts'),
      ROOT
    );
    expect(result.imports).toContain('src/utils.ts');
  });

  it('handles dynamic import()', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `const mod = await import('./lazy')`,
      makeSet('src/main.ts', 'src/lazy.ts'),
      ROOT
    );
    expect(result.imports).toContain('src/lazy.ts');
  });

  it('returns correct sizeChars and lineCount', () => {
    const content = 'line one\nline two\nline three';
    const result = parseFileRefs('src/a.ts', content, makeSet('src/a.ts'), ROOT);
    expect(result.sizeChars).toBe(content.length);
    expect(result.lineCount).toBe(3);
  });

  it('deduplicates imports and exports', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { a } from './shared';
import { b } from './shared';`,
      makeSet('src/main.ts', 'src/shared.ts'),
      ROOT
    );
    expect(result.imports.filter(i => i === 'src/shared.ts')).toHaveLength(1);
  });
});

describe('parseFileRefs — C#', () => {
  it('extracts using directives as namespace imports', () => {
    const result = parseFileRefs(
      'Services/UserService.cs',
      `using System;
using System.Collections.Generic;
using MyApp.Core.Models;`,
      makeSet('Services/UserService.cs'),
      ROOT
    );
    expect(result.imports).toContain('System');
    expect(result.imports).toContain('System.Collections.Generic');
    expect(result.imports).toContain('MyApp.Core.Models');
  });

  it('extracts public class and interface exports', () => {
    const result = parseFileRefs(
      'Services/UserService.cs',
      `public class UserService {}
public interface IRepository {}
internal class Helper {}
public static class Extensions {}`,
      makeSet('Services/UserService.cs'),
      ROOT
    );
    expect(result.exports).toContain('UserService');
    expect(result.exports).toContain('IRepository');
    expect(result.exports).toContain('Helper');
    expect(result.exports).toContain('Extensions');
  });

  it('does not produce file-path refs for C# usings', () => {
    const result = parseFileRefs(
      'Services/UserService.cs',
      `using System;`,
      makeSet('Services/UserService.cs'),
      ROOT
    );
    expect(result.refs).toHaveLength(0);
  });
});

describe('parseFileRefs — text/markdown/JSON', () => {
  it('extracts relative path mentions that exist in project', () => {
    const result = parseFileRefs(
      'README.md',
      `See ./src/utils.ts for details and ../config.json for setup.`,
      makeSet('README.md', 'src/utils.ts'),
      ROOT
    );
    expect(result.refs).toContain('src/utils.ts');
  });

  it('extracts bare path mentions that exist in project', () => {
    const result = parseFileRefs(
      'README.md',
      `The file src/auth/index.ts handles authentication.`,
      makeSet('README.md', 'src/auth/index.ts'),
      ROOT
    );
    expect(result.refs).toContain('src/auth/index.ts');
  });

  it('ignores path mentions not in project file set', () => {
    const result = parseFileRefs(
      'README.md',
      `See ./src/nonexistent.ts`,
      makeSet('README.md'),
      ROOT
    );
    expect(result.refs).toHaveLength(0);
  });

  it('returns no imports or exports for text files', () => {
    const result = parseFileRefs(
      'notes.txt',
      `Some plain text content here.`,
      makeSet('notes.txt'),
      ROOT
    );
    expect(result.imports).toHaveLength(0);
    expect(result.exports).toHaveLength(0);
  });
});
