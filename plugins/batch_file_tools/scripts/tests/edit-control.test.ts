import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBatchEdit } from "../src/tools/edit.js";
import type { EditInput } from "../src/types.js";

let workDir: string;
let counter = 0;

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "btf-ctrl-")));
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

async function edit({ dryRun = false, ...input }: EditInput & { dryRun?: boolean }) {
  return handleBatchEdit(input as EditInput, [workDir], dryRun);
}

describe("stopOnError — file level", () => {
  it("default (continue): a failing op does NOT skip later ops", async () => {
    const p = await fixture("file.txt", "A\nB\nC\n");
    const out = await edit({
      dryRun: false,
      files: [
        {
          path: p,
          ops: [
            { type: "write", mode: "append", content: "D\n" }, // ok
            { type: "replace", old: "ZZZ_no_match", new: "x" }, // error
            { type: "write", mode: "append", content: "E\n" }, // ok — should still run
          ],
        },
      ],
    });
    const ops = out.results[0]!.ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.index).toBe(1);
    expect(ops[0]!.status).toBe("error");
    expect(await readText(p)).toBe("A\nB\nC\nD\nE\n");
  });

  it("file.stopOnError=true: a failing op DOES skip later ops", async () => {
    const p = await fixture("file.txt", "A\n");
    const out = await edit({
      dryRun: false,
      verbose: true,
      files: [
        {
          path: p,
          stopOnError: true,
          ops: [
            { type: "replace", old: "ZZZ", new: "x" }, // error
            { type: "write", mode: "append", content: "B\n" }, // skipped
          ],
        },
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[0]!.ops[1]!.status).toBe("skipped");
    expect(await readText(p)).toBe("A\n"); // no write
  });
});

describe("stopOnError — op level", () => {
  it("op.stopOnError=true under file.stopOnError=false: stops after that op fails", async () => {
    const p = await fixture("file.txt", "A\n");
    const out = await edit({
      dryRun: false,
      files: [
        {
          path: p,
          stopOnError: false,
          ops: [
            { type: "replace", old: "ZZZ", new: "x", stopOnError: true }, // error → stops
            { type: "write", mode: "append", content: "B\n" }, // skipped
          ],
        },
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[0]!.ops[1]!.status).toBe("skipped");
    expect(await readText(p)).toBe("A\n");
  });

  it("op.stopOnError=false under file.stopOnError=true: lets that op continue on failure", async () => {
    const p = await fixture("file.txt", "A\n");
    const out = await edit({
      dryRun: false,
      files: [
        {
          path: p,
          stopOnError: true,
          ops: [
            { type: "replace", old: "ZZZ", new: "x", stopOnError: false }, // error → continues
            { type: "write", mode: "append", content: "B\n" }, // should run
          ],
        },
      ],
    });
    expect(out.results[0]!.ops).toHaveLength(1);
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(await readText(p)).toBe("A\nB\n");
  });
});

describe("stopOnError — root level", () => {
  it("a file with errors aborts later files when root.stopOnError=true", async () => {
    const a = await fixture("a.txt", "A\n");
    const b = await fixture("b.txt", "B\n");
    const out = await edit({
      stopOnError: true,
      dryRun: false,
      files: [
        { path: a, ops: [{ type: "replace", old: "ZZZ", new: "x" }] }, // fails
        { path: b, ops: [{ type: "write", mode: "append", content: "B2\n" }] }, // should be skipped
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[1]!.ops[0]!.status).toBe("skipped");
    expect(await readText(b)).toBe("B\n");
  });

  it("default (continue): later files proceed after an earlier failure", async () => {
    const a = await fixture("a.txt", "A\n");
    const b = await fixture("b.txt", "B\n");
    const out = await edit({
      dryRun: false,
      files: [
        { path: a, ops: [{ type: "replace", old: "ZZZ", new: "x" }] }, // fails
        { path: b, ops: [{ type: "write", mode: "append", content: "B2\n" }] }, // should run
      ],
    });
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[1]!.status).toBe("ok");
    expect(out.results[1]!.ops).toHaveLength(0);
    expect(await readText(b)).toBe("B\nB2\n");
  });
});

describe("dryRun", () => {
  it("reports success but does not modify disk", async () => {
    const p = await fixture("dry.txt", "hello\n");
    const out = await edit({
      dryRun: true,
      files: [{ path: p, ops: [{ type: "write", mode: "append", content: "world\n" }] }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(out.results[0]!.ops).toHaveLength(0);
    expect(await readText(p)).toBe("hello\n"); // unchanged
  });

  it("dryRun + write(overwrite) does NOT create the file on disk", async () => {
    const p = tmpPath("dry_new.txt");
    const out = await edit({
      dryRun: true,
      files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "x\n" }] }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(out.results[0]!.ops).toHaveLength(0);
    const exists = await readFile(p).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });
});

describe("output: non-ok ops only", () => {
  it("all ops ok -> status:'ok', ops empty", async () => {
    const p = await fixture("min-ok.txt", "a\nb\n");
    const out = await edit({
      dryRun: false,
      files: [{ path: p, ops: [{ type: "write", mode: "append", content: "c\n" }] }],
    });
    const fr = out.results[0]!;
    expect(fr.status).toBe("ok");
    expect(fr.ops).toEqual([]);
  });

  it("partial -> status:'partial' with only failed ops carrying type+reason+hint", async () => {
    const p = await fixture("min-partial.txt", "a\nb\n");
    const out = await edit({
      dryRun: false,
      files: [
        {
          path: p,
          ops: [
            { type: "write", mode: "append", content: "c\n" }, // ok
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
  });

  it("total file-load error -> status:'error' with file.error block", async () => {
    const out = await edit({
      dryRun: false,
      files: [
        {
          path: "relative/not-absolute.txt",
          ops: [{ type: "replace", old: "x", new: "y" }],
        },
      ],
    });
    const fr = out.results[0]!;
    expect(fr.status).toBe("error");
    expect(fr.error?.reason).toBe("not_authorized");
  });
});

describe("stopOnError resolution (op > file > root)", () => {
  it("file.stopOnError=false overrides root.stopOnError=true within the file", async () => {
    const p = await fixture("override-stop.txt", "A\n");
    const out = await edit({
      stopOnError: true,
      dryRun: false,
      files: [
        {
          path: p,
          stopOnError: false,
          ops: [
            { type: "replace", old: "ZZZ", new: "x" }, // error
            { type: "write", mode: "append", content: "B\n" }, // should still run
          ],
        },
      ],
    });
    expect(out.results[0]!.ops).toHaveLength(1);
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(await readText(p)).toBe("A\nB\n");
  });

  it("file.stopOnError=false does NOT prevent root-level across-file abort", async () => {
    const a = await fixture("a.txt", "A\n");
    const b = await fixture("b.txt", "B\n");
    const out = await edit({
      stopOnError: true,
      dryRun: false,
      files: [
        {
          path: a,
          stopOnError: false,
          ops: [
            { type: "replace", old: "ZZZ", new: "x" }, // error
            { type: "write", mode: "append", content: "X\n" }, // still runs
          ],
        },
        {
          path: b,
          ops: [{ type: "write", mode: "append", content: "B2\n" }], // skipped (root abort)
        },
      ],
    });
    expect(out.results[0]!.ops).toHaveLength(1);
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[1]!.status).toBe("skipped");
    expect(await readText(b)).toBe("B\n");
  });
});
