import { describe, expect, it } from "vitest";
import { extractRefs } from "../src/lib/extract-refs.js";

describe("extractRefs", () => {
  it("returns empty array for empty content", () => {
    expect(extractRefs("")).toEqual([]);
  });

  it("returns empty array for content with no file refs", () => {
    expect(extractRefs("const x = 1;\nconst y = 2;\n")).toEqual([]);
  });

  it("extracts ES import with relative path", () => {
    const refs = extractRefs("import { foo } from './foo.js';");
    expect(refs).toContain("./foo.js");
  });

  it("extracts ES import with parent-relative path", () => {
    const refs = extractRefs("import bar from '../lib/bar.js';");
    expect(refs).toContain("../lib/bar.js");
  });

  it("ignores npm package names in imports", () => {
    const refs = extractRefs("import React from 'react';\nimport { z } from 'zod';");
    expect(refs).toEqual([]);
  });

  it("ignores node builtins in imports", () => {
    const refs = extractRefs("import { readFile } from 'node:fs/promises';");
    expect(refs).toEqual([]);
  });

  it("extracts require() with relative path", () => {
    const refs = extractRefs("const x = require('./config.js');");
    expect(refs).toContain("./config.js");
  });

  it("ignores require() with package name", () => {
    const refs = extractRefs("const path = require('path');");
    expect(refs).toEqual([]);
  });

  it("extracts dynamic import with relative path", () => {
    const refs = extractRefs("const m = await import('./plugin.js');");
    expect(refs).toContain("./plugin.js");
  });

  it("extracts markdown relative link", () => {
    const refs = extractRefs("[see docs](./docs/guide.md)");
    expect(refs).toContain("./docs/guide.md");
  });

  it("extracts markdown relative image", () => {
    const refs = extractRefs("![logo](./assets/logo.png)");
    expect(refs).toContain("./assets/logo.png");
  });

  it("ignores markdown https links", () => {
    const refs = extractRefs("[Claude](https://claude.ai)");
    expect(refs).toEqual([]);
  });

  it("ignores markdown http links", () => {
    const refs = extractRefs("[site](http://example.com/page)");
    expect(refs).toEqual([]);
  });

  it("extracts relative path literal in non-import context", () => {
    const refs = extractRefs('const cfg = readFileSync("./config.json", "utf8");');
    expect(refs).toContain("./config.json");
  });

  it("extracts absolute Windows path", () => {
    const refs = extractRefs('const p = "C:/Users/foo/bar.ts";');
    expect(refs).toContain("C:/Users/foo/bar.ts");
  });

  it("deduplicates identical refs", () => {
    const content = "import './a.js';\nimport './a.js';\nrequire('./a.js');";
    const refs = extractRefs(content);
    expect(refs.filter(r => r === "./a.js")).toHaveLength(1);
  });

  it("returns refs sorted alphabetically", () => {
    const content = "import './z.js';\nimport './a.js';\nimport './m.js';";
    const refs = extractRefs(content);
    expect(refs).toEqual(["./a.js", "./m.js", "./z.js"]);
  });

  it("handles mixed content with multiple ref types", () => {
    const content = [
      "import { a } from './a.js';",
      "const b = require('../b.js');",
      "[link](./docs/readme.md)",
      "import 'react';",
    ].join("\n");
    const refs = extractRefs(content);
    expect(refs).toContain("./a.js");
    expect(refs).toContain("../b.js");
    expect(refs).toContain("./docs/readme.md");
    expect(refs).not.toContain("react");
  });
});
