import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBatchEdit } from "../src/tools/edit.js";

let workDir: string;
let counter = 0;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "btf-ctrl-"));
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

describe("continueOnError — op level (file-level flag)", () => {
  it("failing op does NOT skip later ops when file.continueOnError=true", async () => {
    const p = await fixture("file.txt", "A\nB\nC\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: false,
      returnDiff: "none",
      files: [
        {
          path: p,
          continueOnError: true,
          ops: [
            { type: "append", content: "D\n" }, // ok
            { type: "replace", old: "ZZZ_no_match", new: "x" }, // error
            { type: "append", content: "E\n" }, // ok — should still run
          ],
        },
      ],
    });
    const ops = out.results[0]!.ops;
    expect(ops[0]!.status).toBe("ok");
    expect(ops[1]!.status).toBe("error");
    expect(ops[2]!.status).toBe("ok");
    expect(await readText(p)).toBe("A\nB\nC\nD\nE\n");
  });

  it("failing op DOES skip later ops when file.continueOnError=false", async () => {
    const p = await fixture("file.txt", "A\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: false,
      returnDiff: "none",
      files: [
        {
          path: p,
          continueOnError: false,
          ops: [
            { type: "replace", old: "ZZZ", new: "x" }, // error
            { type: "append", content: "B\n" }, // skipped
          ],
        },
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[0]!.ops[1]!.status).toBe("skipped");
    expect(await readText(p)).toBe("A\n"); // no write
  });

  it("file-level flag overrides top-level when both set", async () => {
    const p = await fixture("f.txt", "A\n");
    const out = await handleBatchEdit({
      continueOnError: true,
      dryRun: false,
      returnDiff: "none",
      files: [
        {
          path: p,
          continueOnError: false, // this wins for op-level
          ops: [
            { type: "replace", old: "ZZ", new: "x" }, // error
            { type: "append", content: "B\n" }, // should be skipped
          ],
        },
      ],
    });
    expect(out.results[0]!.ops[1]!.status).toBe("skipped");
  });
});

describe("continueOnError — file level (top-level flag)", () => {
  it("a file with errors aborts later files when top-level=false", async () => {
    const a = await fixture("a.txt", "A\n");
    const b = await fixture("b.txt", "B\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: false,
      returnDiff: "none",
      files: [
        { path: a, ops: [{ type: "replace", old: "ZZZ", new: "x" }] }, // fails
        { path: b, ops: [{ type: "append", content: "B2\n" }] }, // should be skipped
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[1]!.ops[0]!.status).toBe("skipped");
    expect(await readText(b)).toBe("B\n");
  });

  it("top-level=true lets later files proceed after an earlier failure", async () => {
    const a = await fixture("a.txt", "A\n");
    const b = await fixture("b.txt", "B\n");
    const out = await handleBatchEdit({
      continueOnError: true,
      dryRun: false,
      returnDiff: "none",
      files: [
        { path: a, ops: [{ type: "replace", old: "ZZZ", new: "x" }] }, // fails
        { path: b, ops: [{ type: "append", content: "B2\n" }] }, // should run
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[1]!.ops[0]!.status).toBe("ok");
    expect(await readText(b)).toBe("B\nB2\n");
  });
});

describe("dryRun", () => {
  it("reports success but does not modify disk", async () => {
    const p = await fixture("dry.txt", "hello\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: true,
      returnDiff: "none",
      files: [{ path: p, ops: [{ type: "append", content: "world\n" }] }],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("hello\n"); // unchanged
  });

  it("dryRun + create does NOT create the file on disk", async () => {
    const p = tmpPath("dry_new.txt");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: true,
      returnDiff: "none",
      files: [{ path: p, ops: [{ type: "create", content: "x\n" }] }],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    const exists = await readFile(p).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

describe("returnDiff", () => {
  it("per_file returns a single unified diff on the FileResult", async () => {
    const p = await fixture("dpf.txt", "a\nb\nc\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: false,
      returnDiff: "per_file",
      files: [{ path: p, ops: [{ type: "replace", old: "b", new: "BEE" }] }],
    });
    expect(out.results[0]!.diff).toBeDefined();
    expect(out.results[0]!.diff).toContain("-b");
    expect(out.results[0]!.diff).toContain("+BEE");
    expect(out.results[0]!.ops[0]!.diff).toBeUndefined();
  });

  it("per_op returns a diff per successful op", async () => {
    const p = await fixture("dpo.txt", "a\nb\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: false,
      returnDiff: "per_op",
      files: [
        {
          path: p,
          ops: [
            { type: "append", content: "c\n" },
            { type: "replace", old: "a", new: "A" },
          ],
        },
      ],
    });
    expect(out.results[0]!.diff).toBeUndefined();
    expect(out.results[0]!.ops[0]!.diff).toContain("+c");
    expect(out.results[0]!.ops[1]!.diff).toContain("-a");
    expect(out.results[0]!.ops[1]!.diff).toContain("+A");
  });

  it("none omits all diffs", async () => {
    const p = await fixture("dn.txt", "x\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: false,
      returnDiff: "none",
      files: [{ path: p, ops: [{ type: "append", content: "y\n" }] }],
    });
    expect(out.results[0]!.diff).toBeUndefined();
    expect(out.results[0]!.ops[0]!.diff).toBeUndefined();
  });

  it("dryRun + per_file still returns a diff", async () => {
    const p = await fixture("dryd.txt", "a\n");
    const out = await handleBatchEdit({
      continueOnError: false,
      dryRun: true,
      returnDiff: "per_file",
      files: [{ path: p, ops: [{ type: "append", content: "b\n" }] }],
    });
    expect(out.results[0]!.diff).toContain("+b");
    expect(await readText(p)).toBe("a\n"); // still unchanged
  });
});
