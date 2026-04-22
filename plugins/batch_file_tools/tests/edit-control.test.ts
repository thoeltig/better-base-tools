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
      output: "summary",
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
      output: "summary",
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
      output: "summary",
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
      output: "summary",
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
      output: "summary",
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
      output: "summary",
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
      output: "summary",
      files: [{ path: p, ops: [{ type: "create", content: "x\n" }] }],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("ok");
    const exists = await readFile(p).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

describe("output modes", () => {
  describe("minimal (default)", () => {
    it("all ops ok -> {path,status:'ok'}, no ops array", async () => {
      const p = await fixture("min-ok.txt", "a\nb\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "minimal",
        files: [{ path: p, ops: [{ type: "append", content: "c\n" }] }],
      });
      const fr = out.results[0]!;
      expect(fr.status).toBe("ok");
      expect(fr.ops).toEqual([]);
      expect(fr.diff).toBeUndefined();
    });

    it("partial -> status:'partial' with only failed ops carrying type+reason+hint", async () => {
      const p = await fixture("min-partial.txt", "a\nb\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "minimal",
        files: [
          {
            path: p,
            continueOnError: true,
            ops: [
              { type: "append", content: "c\n" }, // ok
              { type: "replace", old: "ZZZ", new: "x" }, // error
            ],
          },
        ],
      });
      const fr = out.results[0]!;
      expect(fr.status).toBe("partial");
      expect(fr.ops).toHaveLength(1);
      const failed = fr.ops[0]!;
      expect(failed.index).toBe(1);
      expect(failed.type).toBe("replace");
      expect(failed.status).toBe("error");
      expect(failed.reason).toBe("not_found");
      expect(failed.summary).toBeUndefined();
    });

    it("total file-load error -> status:'error' with file.error block", async () => {
      const out = await handleBatchEdit({
        continueOnError: true,
        dryRun: false,
        output: "minimal",
        files: [
          {
            path: "relative/not-absolute.txt",
            ops: [{ type: "replace", old: "x", new: "y" }],
          },
        ],
      });
      const fr = out.results[0]!;
      expect(fr.status).toBe("error");
      expect(fr.error?.reason).toBe("io_error");
    });
  });

  describe("summary", () => {
    it("emits all ops with status+summary strings", async () => {
      const p = await fixture("sum.txt", "a\nb\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "summary",
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
      const ops = out.results[0]!.ops;
      expect(ops).toHaveLength(2);
      expect(ops[0]!.summary).toMatch(/appended 1 line/);
      expect(ops[1]!.summary).toMatch(/replaced 1 occurrence/);
      expect(ops[0]!.diff).toBeUndefined();
    });
  });

  describe("diff", () => {
    it("file-level diff returns a whole-file unified diff", async () => {
      const p = await fixture("diff-file.txt", "a\nb\nc\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "diff",
        files: [{ path: p, ops: [{ type: "replace", old: "b", new: "BEE" }] }],
      });
      const fr = out.results[0]!;
      expect(fr.diff).toContain("-\tb");
      expect(fr.diff).toContain("+\tBEE");
      // diff mode: ops array includes only non-ok ops (there are none here).
      expect(fr.ops).toEqual([]);
    });

    it("op-level diff returns per-op diffs, summary stripped", async () => {
      const p = await fixture("diff-op.txt", "a\nb\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "summary",
        files: [
          {
            path: p,
            ops: [
              { type: "append", content: "c\n", output: "diff" },
              { type: "replace", old: "a", new: "A" }, // inherits summary
            ],
          },
        ],
      });
      const ops = out.results[0]!.ops;
      expect(ops[0]!.diff).toContain("+\tc");
      expect(ops[0]!.summary).toBeUndefined();
      expect(ops[1]!.diff).toBeUndefined();
      expect(ops[1]!.summary).toMatch(/replaced 1 occurrence/);
    });

    it("dryRun + diff still returns a file diff", async () => {
      const p = await fixture("diff-dry.txt", "a\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: true,
        output: "diff",
        files: [{ path: p, ops: [{ type: "append", content: "b\n" }] }],
      });
      expect(out.results[0]!.diff).toContain("+\tb");
      expect(await readText(p)).toBe("a\n");
    });
  });

  describe("precedence", () => {
    it("op-level output overrides file-level", async () => {
      const p = await fixture("prec-op.txt", "a\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "minimal",
        files: [
          {
            path: p,
            output: "minimal",
            ops: [{ type: "append", content: "b\n", output: "summary" }],
          },
        ],
      });
      const ops = out.results[0]!.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.summary).toMatch(/appended 1 line/);
    });

    it("file-level output overrides root", async () => {
      const p = await fixture("prec-file.txt", "a\n");
      const out = await handleBatchEdit({
        continueOnError: false,
        dryRun: false,
        output: "minimal",
        files: [
          {
            path: p,
            output: "summary",
            ops: [{ type: "append", content: "b\n" }],
          },
        ],
      });
      const ops = out.results[0]!.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]!.summary).toMatch(/appended 1 line/);
    });
  });
});
