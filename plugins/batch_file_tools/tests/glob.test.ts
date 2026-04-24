import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBatchEdit } from "../src/tools/edit.js";
import type { EditFile } from "../src/types.js";

let allowedDir: string;
let outsideDir: string;
let caseDir: string;
let counter = 0;

beforeAll(async () => {
  allowedDir = await realpath(await mkdtemp(join(tmpdir(), "btf-glob-in-")));
  outsideDir = await realpath(await mkdtemp(join(tmpdir(), "btf-glob-out-")));
});

afterAll(async () => {
  await rm(allowedDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

beforeEach(async () => {
  counter++;
  caseDir = join(allowedDir, `c${counter}`);
  await mkdir(caseDir, { recursive: true });
});

async function makeFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, content, { encoding: "utf8" });
  }
}

async function runEdit(file: EditFile, allowed: string[] = [allowedDir]) {
  return handleBatchEdit(
    {
      continueOnError: true,
      dryRun: false,
      output: "summary",
      files: [file],
    },
    allowed,
  );
}

describe("glob expansion — replace_all", () => {
  it("applies to every matched file in a flat directory", async () => {
    await makeFiles(caseDir, {
      "a.txt": "foo line\n",
      "b.txt": "foo here\n",
      "c.txt": "foo last\n",
    });
    const out = await runEdit({
      path: join(caseDir, "*.txt"),
      ops: [{ type: "replace_all", old: "foo", new: "bar" }],
    });
    expect(out.results).toHaveLength(3);
    for (const r of out.results) {
      expect(r.status).toBe("ok");
      expect(r.ops[0]!.status).toBe("ok");
    }
    expect(await readFile(join(caseDir, "a.txt"), "utf8")).toBe("bar line\n");
    expect(await readFile(join(caseDir, "b.txt"), "utf8")).toBe("bar here\n");
    expect(await readFile(join(caseDir, "c.txt"), "utf8")).toBe("bar last\n");
  });

  it("directory path matches only immediate children (single level, non-recursive)", async () => {
    await makeFiles(caseDir, {
      "top.txt": "foo\n",
      "sub/mid.txt": "foo\n",
      "sub/deep/leaf.txt": "foo\n",
    });
    const out = await runEdit({
      path: caseDir,
      ops: [{ type: "replace_all", old: "foo", new: "bar" }],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readFile(join(caseDir, "top.txt"), "utf8")).toBe("bar\n");
    expect(await readFile(join(caseDir, "sub/mid.txt"), "utf8")).toBe("foo\n");
    expect(await readFile(join(caseDir, "sub/deep/leaf.txt"), "utf8")).toBe("foo\n");
  });

  it("explicit `**` glob recurses across directories", async () => {
    await makeFiles(caseDir, {
      "top.txt": "foo\n",
      "sub/mid.txt": "foo\n",
      "sub/deep/leaf.txt": "foo\n",
    });
    const out = await runEdit({
      path: `${caseDir.replace(/\\/g, "/")}/**/*.txt`,
      ops: [{ type: "replace_all", old: "foo", new: "bar" }],
    });
    expect(out.results).toHaveLength(3);
    for (const r of out.results) expect(r.status).toBe("ok");
    expect(await readFile(join(caseDir, "top.txt"), "utf8")).toBe("bar\n");
    expect(await readFile(join(caseDir, "sub/mid.txt"), "utf8")).toBe("bar\n");
    expect(await readFile(join(caseDir, "sub/deep/leaf.txt"), "utf8")).toBe("bar\n");
  });

  it("per-resolved-file 0-match still errors as not_found (single-file parity)", async () => {
    await makeFiles(caseDir, {
      "hit.txt": "foo\n",
      "miss.txt": "baz\n",
    });
    const out = await runEdit({
      path: join(caseDir, "*.txt"),
      ops: [{ type: "replace_all", old: "foo", new: "bar" }],
    });
    const byPath = new Map(out.results.map((r) => [r.path.toLowerCase(), r]));
    const hit = [...byPath.entries()].find(([p]) => p.endsWith("hit.txt"))![1];
    const miss = [...byPath.entries()].find(([p]) => p.endsWith("miss.txt"))![1];
    expect(hit.status).toBe("ok");
    expect(miss.ops[0]!.reason).toBe("not_found");
  });
});

describe("glob expansion — write(append)", () => {
  it("appends to every matched file", async () => {
    await makeFiles(caseDir, {
      "a.log": "line1\n",
      "b.log": "line1\n",
    });
    const out = await runEdit({
      path: join(caseDir, "*.log"),
      ops: [{ type: "write", mode: "append", content: "line2\n" }],
    });
    expect(out.results).toHaveLength(2);
    for (const r of out.results) expect(r.status).toBe("ok");
    expect(await readFile(join(caseDir, "a.log"), "utf8")).toBe("line1\nline2\n");
    expect(await readFile(join(caseDir, "b.log"), "utf8")).toBe("line1\nline2\n");
  });
});

describe("glob expansion — incompatible ops", () => {
  it("rejects insert_at_line with not_supported", async () => {
    await makeFiles(caseDir, { "a.txt": "x\n" });
    const out = await runEdit({
      path: join(caseDir, "*.txt"),
      ops: [{ type: "insert_at_line", line: 1, content: "y\n" }],
    });
    expect(out.results).toHaveLength(1);
    const r = out.results[0]!;
    expect(r.status).toBe("error");
    expect(r.error?.reason).toBe("not_supported");
    expect(r.ops[0]!.reason).toBe("not_supported");
  });

  it("rejects replace_range with not_supported", async () => {
    await makeFiles(caseDir, { "a.txt": "x\ny\n" });
    const out = await runEdit({
      path: join(caseDir, "*.txt"),
      ops: [{ type: "replace_range", start: 1, end: 2, content: "z\n" }],
    });
    expect(out.results[0]!.error?.reason).toBe("not_supported");
  });

  it("rejects write(overwrite) with not_supported", async () => {
    await makeFiles(caseDir, { "a.txt": "x\n" });
    const out = await runEdit({
      path: join(caseDir, "*.txt"),
      ops: [{ type: "write", mode: "overwrite", content: "new\n" }],
    });
    expect(out.results[0]!.error?.reason).toBe("not_supported");
    expect(await readFile(join(caseDir, "a.txt"), "utf8")).toBe("x\n");
  });
});

describe("glob expansion — match outcomes", () => {
  it("0 matches yields a single not_found file error", async () => {
    await makeFiles(caseDir, { "a.txt": "x\n" });
    const out = await runEdit({
      path: join(caseDir, "*.nope"),
      ops: [{ type: "replace_all", old: "x", new: "y" }],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.error?.reason).toBe("not_found");
  });

  it("matched files outside allowed dirs yield not_authorized", async () => {
    await makeFiles(outsideDir, { "secret.txt": "foo\n" });
    const out = await runEdit({
      path: join(outsideDir, "*.txt"),
      ops: [{ type: "replace_all", old: "foo", new: "bar" }],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await readFile(join(outsideDir, "secret.txt"), "utf8")).toBe("foo\n");
  });

  it("relative glob path errors as not_absolute", async () => {
    const out = await runEdit({
      path: "*.txt",
      ops: [{ type: "replace_all", old: "a", new: "b" }],
    });
    expect(out.results[0]!.error?.reason).toBe("not_absolute");
  });
});

describe("glob expansion — merge with concrete entries", () => {
  it("merges across mixed path separators / case (Windows-tolerant dedupe)", async () => {
    await makeFiles(caseDir, { "only.txt": "foo\n" });
    const target = join(caseDir, "only.txt");
    const altSep = target.replace(/\\/g, "/");
    const out = await handleBatchEdit(
      {
        continueOnError: true,
        dryRun: false,
        output: "summary",
        files: [
          { path: target, ops: [{ type: "write", mode: "append", content: "A\n" }] },
          { path: altSep, ops: [{ type: "write", mode: "append", content: "B\n" }] },
        ],
      },
      [allowedDir],
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.ops).toHaveLength(2);
    expect(await readFile(target, "utf8")).toBe("foo\nA\nB\n");
  });

  it("merges ops onto a concrete entry when glob resolves to the same path", async () => {
    await makeFiles(caseDir, {
      "only.txt": "alpha\nbeta\n",
    });
    const target = join(caseDir, "only.txt");
    const out = await handleBatchEdit(
      {
        continueOnError: true,
        dryRun: false,
        output: "summary",
        files: [
          { path: target, ops: [{ type: "replace", old: "alpha", new: "ALPHA" }] },
          { path: join(caseDir, "*.txt"), ops: [{ type: "replace_all", old: "beta", new: "BETA" }] },
        ],
      },
      [allowedDir],
    );
    expect(out.results).toHaveLength(1);
    const r = out.results[0]!;
    expect(r.status).toBe("ok");
    expect(r.ops).toHaveLength(2);
    expect(await readFile(target, "utf8")).toBe("ALPHA\nBETA\n");
  });
});
