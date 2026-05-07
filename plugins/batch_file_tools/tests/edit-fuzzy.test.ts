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
beforeEach(() => {
  counter++;
});

function tmpPath(name: string): string {
  return join(workDir, `${counter}-${name}`);
}

async function fixture(name: string, content: string): Promise<string> {
  const p = tmpPath(name);
  await writeFile(p, content, { encoding: "utf8" });
  return p;
}

async function readText(p: string): Promise<string> {
  return readFile(p, { encoding: "utf8" });
}

async function runReplace(filePath: string, old: string, newStr: string) {
  return handleBatchEdit(
    { verbose: true, files: [{ path: filePath, ops: [{ type: "replace", old, new: newStr }] }] },
    [workDir],
  );
}

async function runReplaceAll(filePath: string, old: string, newStr: string) {
  return handleBatchEdit(
    { verbose: true, files: [{ path: filePath, ops: [{ type: "replace_all", old, new: newStr }] }] },
    [workDir],
  );
}

describe("replace — fuzzy whitespace fallback", () => {
  it("matches when file uses tabs but old uses 2-space indent", async () => {
    const p = await fixture("tabs.ts", "function foo() {\n\treturn 1;\n}\n");
    const out = await runReplace(p, "function foo() {\n  return 1;\n}\n", "function foo() {\n  return 2;\n}\n");
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    expect(out.results[0]!.ops[0]!.summary).toMatch(/whitespace-normalized match/);
    expect(await readText(p)).toBe("function foo() {\n  return 2;\n}\n");
  });

  it("matches when file uses 4-space indent but old uses 2-space", async () => {
    const p = await fixture("4space.ts", "function foo() {\n    return 1;\n}\n");
    const out = await runReplace(p, "function foo() {\n  return 1;\n}\n", "function foo() {\n  return 99;\n}\n");
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    expect(out.results[0]!.ops[0]!.summary).toMatch(/whitespace-normalized match/);
    expect(await readText(p)).toBe("function foo() {\n  return 99;\n}\n");
  });

  it("exact match still works — fuzzy path not triggered", async () => {
    const p = await fixture("exact.ts", "const x = 1;\n");
    const out = await runReplace(p, "const x = 1;\n", "const x = 2;\n");
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    expect(out.results[0]!.ops[0]!.summary).not.toMatch(/whitespace-normalized/);
    expect(await readText(p)).toBe("const x = 2;\n");
  });

  it("returns error when content differs (not just whitespace)", async () => {
    const p = await fixture("content-diff.ts", "const x = 1;\n");
    const out = await runReplace(p, "const y = 1;\n", "const y = 2;\n");
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(await readText(p)).toBe("const x = 1;\n");
  });

  it("returns nearest_anchor hint on content mismatch", async () => {
    const p = await fixture("hint.ts", "function greet() {\n  return 'hello';\n}\n");
    const out = await runReplace(p, "function greet() {\n  return 'bye';\n}\n", "x");
    const op = out.results[0]!.ops[0]!;
    expect(op.status).toBe("error");
    expect(op.hint?.nearest_anchor).toBeDefined();
  });

  it("matches without trailing newline in old even though file has one", async () => {
    const p = await fixture("trail.ts", "const a = 1;\n");
    const out = await runReplace(p, "const a = 1;", "const a = 2;");
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    // exact match finds substring — trailing \n is preserved from original file
    expect(await readText(p)).toBe("const a = 2;\n");
  });
});

describe("replace_all — fuzzy whitespace fallback", () => {
  it("matches and replaces when file uses tabs but old uses 2-space", async () => {
    const p = await fixture("tabs-all.ts", "function foo() {\n\treturn 1;\n}\n");
    const out = await runReplaceAll(p, "function foo() {\n  return 1;\n}\n", "function foo() {\n  return 99;\n}\n");
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    expect(out.results[0]!.ops[0]!.summary).toMatch(/whitespace-normalized match/);
    expect(await readText(p)).toBe("function foo() {\n  return 99;\n}\n");
  });

  it("returns error when no fuzzy match found", async () => {
    const p = await fixture("no-match-all.ts", "const x = 1;\n");
    const out = await runReplaceAll(p, "const z = 999;\n", "x");
    expect(out.results[0]!.ops[0]!.status).toBe("error");
  });
});
