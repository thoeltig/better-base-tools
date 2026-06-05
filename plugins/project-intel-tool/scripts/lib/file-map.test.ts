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
    expect(result.imports).toEqual({ 'src/utils.ts': ['foo'] });
    expect(result.refs).toEqual([]);
  });

  it('resolves relative import via index.ts fallback', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { x } from './services/auth'`,
      makeSet('src/main.ts', 'src/services/auth/index.ts'),
      ROOT
    );
    expect(result.imports).toHaveProperty('src/services/auth/index.ts', ['x']);
    expect(result.refs).toHaveLength(0);
  });

  it('resolves parent directory import', () => {
    const result = parseFileRefs(
      'src/features/login.ts',
      `import { helper } from '../shared/helper'`,
      makeSet('src/features/login.ts', 'src/shared/helper.ts'),
      ROOT
    );
    expect(result.imports).toHaveProperty('src/shared/helper.ts', ['helper']);
    expect(result.refs).toHaveLength(0);
  });

  it('extracts external package names with named imports', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import React from 'react'; import { z } from 'zod';`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(result.imports).toHaveProperty('react', ['React']);
    expect(result.imports).toHaveProperty('zod', ['z']);
    expect(result.refs).toHaveLength(0);
  });

  it('extracts scoped package names with named imports', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import Anthropic from '@anthropic-ai/sdk'; import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(result.imports).toHaveProperty('@anthropic-ai/sdk', ['Anthropic']);
    expect(result.imports).toHaveProperty('@modelcontextprotocol/sdk', ['Server']);
  });

  it('ignores import not found in project file set', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { x } from './missing'`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(Object.keys(result.imports)).toHaveLength(0);
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
    expect(result.exports).not.toContain('parse');
  });

  it('handles require() calls — local goes to refs', () => {
    const result = parseFileRefs(
      'src/legacy.js',
      `const utils = require('./utils')`,
      makeSet('src/legacy.js', 'src/utils.ts'),
      ROOT
    );
    expect(result.refs).toContain('src/utils.ts');
    expect(Object.keys(result.imports)).toHaveLength(0);
  });

  it('handles dynamic import() — local goes to refs', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `const mod = await import('./lazy')`,
      makeSet('src/main.ts', 'src/lazy.ts'),
      ROOT
    );
    expect(result.refs).toContain('src/lazy.ts');
    expect(Object.keys(result.imports)).toHaveLength(0);
  });

  it('returns correct sizeChars and lineCount', () => {
    const content = 'line one\nline two\nline three';
    const result = parseFileRefs('src/a.ts', content, makeSet('src/a.ts'), ROOT);
    expect(result.sizeChars).toBe(content.length);
    expect(result.lineCount).toBe(3);
  });

  it('merges named imports from duplicate static imports of same file', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { a } from './shared'; import { b } from './shared';`,
      makeSet('src/main.ts', 'src/shared.ts'),
      ROOT
    );
    expect(result.imports['src/shared.ts']).toEqual(expect.arrayContaining(['a', 'b']));
    expect(result.imports['src/shared.ts']).toHaveLength(2);
    expect(result.refs).toHaveLength(0);
  });

  it('extracts namespace import alias', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import * as fs from 'fs';`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(result.imports).toHaveProperty('fs', ['fs']);
  });

  it('extracts type-only named import', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import type { Foo } from './types'`,
      makeSet('src/main.ts', 'src/types.ts'),
      ROOT
    );
    expect(result.imports).toHaveProperty('src/types.ts', ['Foo']);
  });

  it('extracts mixed default and named imports', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import React, { useState, useEffect } from 'react';`,
      makeSet('src/main.ts'),
      ROOT
    );
    expect(result.imports['react']).toEqual(expect.arrayContaining(['React', 'useState', 'useEffect']));
  });

  it('handles aliased imports — uses local alias name', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { foo as bar } from './utils'`,
      makeSet('src/main.ts', 'src/utils.ts'),
      ROOT
    );
    expect(result.imports['src/utils.ts']).toContain('bar');
    expect(result.imports['src/utils.ts']).not.toContain('foo');
  });

  it('handles multiline named imports', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import {\n  SamplingBatch,\n  ScanConfig,\n} from './types'`,
      makeSet('src/main.ts', 'src/types.ts'),
      ROOT
    );
    expect(result.imports['src/types.ts']).toEqual(expect.arrayContaining(['SamplingBatch', 'ScanConfig']));
  });

  it('bare side-effect import of local file goes to refs', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import './polyfill'`,
      makeSet('src/main.ts', 'src/polyfill.ts'),
      ROOT
    );
    expect(result.refs).toContain('src/polyfill.ts');
    expect(Object.keys(result.imports)).toHaveLength(0);
  });

  it('extracts mixed default and named imports from local file', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import React, { useState } from './react-compat'`,
      makeSet('src/main.ts', 'src/react-compat.ts'),
      ROOT
    );
    expect(result.imports['src/react-compat.ts']).toEqual(expect.arrayContaining(['React', 'useState']));
  });

  it('extracts default and namespace import from local file', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import Default, * as NS from './utils'`,
      makeSet('src/main.ts', 'src/utils.ts'),
      ROOT
    );
    expect(result.imports['src/utils.ts']).toEqual(expect.arrayContaining(['Default', 'NS']));
  });

  it('extracts type namespace import', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import type * as Types from './types'`,
      makeSet('src/main.ts', 'src/types.ts'),
      ROOT
    );
    expect(result.imports['src/types.ts']).toEqual(['Types']);
  });

  it('extracts inline type modifier mixed with value import', () => {
    const result = parseFileRefs(
      'src/main.ts',
      `import { type Foo, Bar } from './types'`,
      makeSet('src/main.ts', 'src/types.ts'),
      ROOT
    );
    expect(result.imports['src/types.ts']).toEqual(expect.arrayContaining(['Foo', 'Bar']));
  });
});

describe('parseFileRefs — C#', () => {
  it('extracts using directives as namespace imports with empty value arrays', () => {
    const result = parseFileRefs(
      'Services/UserService.cs',
      `using System;
using System.Collections.Generic;
using MyApp.Core.Models;`,
      makeSet('Services/UserService.cs'),
      ROOT
    );
    expect(result.imports).toHaveProperty('System', []);
    expect(result.imports).toHaveProperty('System.Collections.Generic', []);
    expect(result.imports).toHaveProperty('MyApp.Core.Models', []);
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
    expect(Object.keys(result.imports)).toHaveLength(0);
    expect(result.exports).toHaveLength(0);
  });
});
