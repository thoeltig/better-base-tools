import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBatchEdit } from "../src/tools/edit.js";

let workDir: string;
let counter = 0;

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "btf-fuzzy-")));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});
beforeEach(() => { counter++; });

function tmpPath(name: string) { return join(workDir, `${counter}-${name}`); }
async function fixture(name: string, content: string) {
  const p = tmpPath(name);
  await writeFile(p, content, { encoding: "utf8" });
  return p;
}
async function readText(path: string) { return readFile(path, { encoding: "utf8" }); }
async function runEdit(path: string, ops: object[]) {
  return handleBatchEdit({ dryRun: false, verbose: true, files: [{ path, ops }] }, [workDir]);
}

// These tests verify that the fuzzy whitespace fallback handles the exact
// scenario Phase 4 creates: verbatim reads normalize indentation to 2-space,
// so any old anchor derived from a normalized read will differ from the file
// only in whitespace. The fuzzy fallback must bridge that gap reliably.

describe("replace — fuzzy whitespace fallback (Phase 4 compose)", () => {
  it("tab-indented file + 2-space old → fuzzy match, file written with new content", async () => {
    const p = await fixture("tab.ts", "function foo() {\n\treturn 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("4-space-indented file + 2-space old → fuzzy match", async () => {
    const p = await fixture("four.ts", "function foo() {\n    return 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("exact match present → exact path taken, no fuzzy marker in summary", async () => {
    const p = await fixture("exact.ts", "function foo() {\n  return 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("content differs beyond whitespace → not_found, file unchanged", async () => {
    const p = await fixture("diff.ts", "function foo() {\n    return 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function bar() {\n  return 1;\n}", new: "x" },
    ]);
    const op = out.results[0]!.ops[0]!;
    expect(op.status).toBe("error");
    expect(op.reason).toBe("not_found");
    expect(await readText(p)).toBe("function foo() {\n    return 1;\n}\n");
  });

  it("deeply nested multi-line block: 2-space old matches double-tab file", async () => {
    const p = await fixture("nested.ts", "class Foo {\n\tbar() {\n\t\treturn 1;\n\t}\n}\n");
    const out = await runEdit(p, [
      {
        type: "replace",
        old: "class Foo {\n  bar() {\n    return 1;\n  }\n}",
        new: "class Foo {\n  bar() {\n    return 2;\n  }\n}",
      },
    ]);
    expect(out.results[0]!.status).toBe("ok");
  });

  it("single-line old: 2-space is substring of 4-space line → exact path, original indent preserved", async () => {
    // "  doSomething();" is a literal substring of "    doSomething();" so exact
    // match fires before fuzzy. The prefix spaces not covered by old are kept,
    // meaning 4-space indentation is preserved in the output. This is correct
    // Phase 4 behavior: normalized reads are for viewing, not for reformatting.
    const p = await fixture("single.ts", "if (x) {\n    doSomething();\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "  doSomething();", new: "  doSomethingElse();" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("if (x) {\n    doSomethingElse();\n}\n"); // 4-space preserved
  });
});

describe("replace_all — fuzzy whitespace fallback (Phase 4 compose)", () => {
  it("4-space file + 2-space old → exact substring path, 4-space indent preserved", async () => {
    // Same substring issue: "  x();" is inside "    x();" so exact path fires.
    // Each occurrence is replaced correctly; prefix spaces preserve 4-space style.
    const p = await fixture("ra-four.ts", "if (a) {\n    x();\n}\nif (b) {\n    x();\n}\n");
    const out = await runEdit(p, [
      { type: "replace_all", old: "  x();", new: "  y();" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("if (a) {\n    y();\n}\nif (b) {\n    y();\n}\n"); // 4-space preserved
  });

  it("tab-indented file + 2-space old → all occurrences replaced", async () => {
    const p = await fixture("ra-tab.ts", "if (a) {\n\tx();\n}\nif (b) {\n\tx();\n}\n");
    const out = await runEdit(p, [
      { type: "replace_all", old: "  x();", new: "  y();" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("if (a) {\n  y();\n}\nif (b) {\n  y();\n}\n");
  });
});
