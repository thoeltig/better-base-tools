import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after, beforeEach } from "node:test";
import { expect } from "./helpers/expect.js";
import { handleBatchEdit } from "../src/tools/edit.js";
import type { EditOp } from "../src/types.js";

let workDir: string;
let counter = 0;

before(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "btf-fuzzy-")));
});
after(async () => {
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
async function runEdit(path: string, ops: EditOp[]) {
  return handleBatchEdit({ files: [{ path, ops }] }, [workDir], false);
}
// `replace`/`replace_all` fall back to a whitespace-normalized comparison when the exact anchor
// match fails, then edit the matched ORIGINAL text. This matters because an anchor's whitespace
// often will not match the file: the model writes one from habit (2-space dominates training data)
// against a tab- or 4-space-indented file, or derives it from a `compact` read, which collapses
// whitespace runs. These tests pin both halves — whitespace-only gaps are bridged, anything
// differing beyond whitespace is refused — plus the rule that an edit never reformats what it touches.
// whitespace only. The fallback must bridge that gap reliably.

describe("replace — whitespace-tolerant anchor matching", () => {
  it("a space-indented anchor matches a tab-indented file", async () => {
    const p = await fixture("tab.ts", "function foo() {\n\treturn 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("a 2-space anchor matches a 4-space file", async () => {
    const p = await fixture("four.ts", "function foo() {\n    return 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("an exact anchor match wins over the whitespace-tolerant path", async () => {
    const p = await fixture("exact.ts", "function foo() {\n  return 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function foo() {\n  return 1;\n}", new: "function foo() {\n  return 2;\n}" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("a difference beyond whitespace is refused — not_found, file untouched", async () => {
    const p = await fixture("diff.ts", "function foo() {\n    return 1;\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "function bar() {\n  return 1;\n}", new: "x" },
    ]);
    const op = out.results[0]!.ops[0]!;
    expect(op.status).toBe("error");
    expect(op.reason).toBe("not_found");
    expect(await readText(p)).toBe("function foo() {\n    return 1;\n}\n");
  });

  it("a multi-line block matches across differing indent depths", async () => {
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

  it("a single-line anchor inside an indented line edits it without reformatting it", async () => {
    // "  doSomething();" is a literal substring of "    doSomething();", so the exact path
    // fires and the two prefix spaces the anchor does not cover stay put. The file keeps its
    // 4-space style: an edit must never reformat the line it touches.
    const p = await fixture("single.ts", "if (x) {\n    doSomething();\n}\n");
    const out = await runEdit(p, [
      { type: "replace", old: "  doSomething();", new: "  doSomethingElse();" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("if (x) {\n    doSomethingElse();\n}\n"); // 4-space preserved
  });
});

describe("replace_all — whitespace-tolerant anchor matching", () => {
  it("every occurrence is replaced without reformatting the file's indentation", async () => {
    // Same substring case as above: "  x();" sits inside "    x();", so the exact path fires
    // at every occurrence and each one keeps its original 4-space prefix.
    const p = await fixture("ra-four.ts", "if (a) {\n    x();\n}\nif (b) {\n    x();\n}\n");
    const out = await runEdit(p, [
      { type: "replace_all", old: "  x();", new: "  y();" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("if (a) {\n    y();\n}\nif (b) {\n    y();\n}\n"); // 4-space preserved
  });

  it("every occurrence is replaced when the anchor's indentation differs from the file", async () => {
    const p = await fixture("ra-tab.ts", "if (a) {\n\tx();\n}\nif (b) {\n\tx();\n}\n");
    const out = await runEdit(p, [
      { type: "replace_all", old: "  x();", new: "  y();" },
    ]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("if (a) {\n  y();\n}\nif (b) {\n  y();\n}\n");
  });
});
