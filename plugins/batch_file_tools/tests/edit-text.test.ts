import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBatchEditText } from "../src/tools/edit-text.js";

let workDir: string;
let counter = 0;

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "btf-edit-text-")));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});
beforeEach(() => {
  counter++;
});

function tmpPath(name: string): string {
  return join(workDir, `${counter}-${name}`).replace(/\\/g, "/");
}
async function fixture(name: string, content: string): Promise<string> {
  const p = tmpPath(name);
  await writeFile(p, content, { encoding: "utf8" });
  return p;
}
async function readText(p: string): Promise<string> {
  return readFile(p, { encoding: "utf8" });
}

describe("handleBatchEditText — happy path", () => {
  it("write overwrite creates a file", async () => {
    const p = tmpPath("a.txt");
    const text = [
      "verbose: true",
      `File: ${p}`,
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "hello",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("hello");
  });

  it("replace edits an existing file", async () => {
    const p = await fixture("b.txt", "alpha\nbeta\ngamma\n");
    const text = [
      `File: ${p}`,
      "Action: replace",
      "<<<OLD",
      "beta",
      "OLD>>>",
      "<<<NEW",
      "BETA",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("alpha\nBETA\ngamma\n");
  });

  it("multi-op same file", async () => {
    const p = await fixture("c.txt", "one\ntwo\nthree\n");
    const text = [
      "verbose: true",
      `File: ${p}`,
      "Action: replace",
      "<<<OLD",
      "one",
      "OLD>>>",
      "<<<NEW",
      "ONE",
      "NEW>>>",
      "Action: replace",
      "<<<OLD",
      "three",
      "OLD>>>",
      "<<<NEW",
      "THREE",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.status).toBe("ok");
    expect(out.results[0]!.ops).toHaveLength(2);
    expect(await readText(p)).toBe("ONE\ntwo\nTHREE\n");
  });

  it("multi-file", async () => {
    const p1 = await fixture("d.txt", "x\n");
    const p2 = await fixture("e.txt", "y\n");
    const text = [
      `File: ${p1}`,
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "X",
      "NEW>>>",
      `File: ${p2}`,
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "Y",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.status).toBe("ok");
    expect(out.results[1]!.status).toBe("ok");
    expect(await readText(p1)).toBe("X");
    expect(await readText(p2)).toBe("Y");
  });

  it("dryRun does not write", async () => {
    const p = await fixture("dry.txt", "before\n");
    const text = [
      "dryRun: true",
      `File: ${p}`,
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "after",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("before\n");
  });
});

describe("handleBatchEditText — parser errors", () => {
  it("rootError → single error result", async () => {
    const text = "stopOnError: yes\nFile: foo\nAction: write\nmode: overwrite\n<<<NEW\nx\nNEW>>>\n";
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.status).toBe("error");
    expect(out.results[0]!.error?.reason).toBe("unparseable");
  });

  it("no File: header → unparseable", async () => {
    const out = await handleBatchEditText({ content: "verbose: true\n" }, [workDir]);
    expect(out.results[0]!.status).toBe("error");
    expect(out.results[0]!.error?.reason).toBe("unparseable");
  });

  it("unparseable file followed by ok file (no stopOnError) → second runs", async () => {
    const p2 = await fixture("ok.txt", "");
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "no close",
      `File: ${p2}`,
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "ran",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.status).toBe("error");
    expect(out.results[0]!.error?.reason).toBe("unparseable");
    expect(out.results[1]!.status).toBe("ok");
    expect(await readText(p2)).toBe("ran");
  });

  it("unparseable file with stopOnError=true → second skipped", async () => {
    const p2 = await fixture("notran.txt", "untouched\n");
    const text = [
      "stopOnError: true",
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "no close",
      `File: ${p2}`,
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "should not happen",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.status).toBe("error");
    expect(out.results[1]!.status).toBe("skipped");
    expect(await readText(p2)).toBe("untouched\n");
  });

  it("file with mixed parseable/unparseable ops → partial status", async () => {
    const p = await fixture("mixed.txt", "alpha\nbeta\n");
    const text = [
      "verbose: true",
      `File: ${p}`,
      "Action: replace",
      "<<<OLD",
      "alpha",
      "OLD>>>",
      "<<<NEW",
      "ALPHA",
      "NEW>>>",
      "Action: insert_at_line",
      "<<<NEW",
      "no line scalar",
      "NEW>>>",
      "Action: replace",
      "<<<OLD",
      "beta",
      "OLD>>>",
      "<<<NEW",
      "BETA",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.status).toBe("partial");
    const ops = out.results[0]!.ops;
    expect(ops).toHaveLength(3);
    expect(ops[0]!.status).toBe("ok");
    expect(ops[1]!.status).toBe("error");
    expect(ops[1]!.reason).toBe("unparseable");
    expect(ops[2]!.status).toBe("ok");
    expect(await readText(p)).toBe("ALPHA\nBETA\n");
  });
});

describe("handleBatchEditText — runtime errors", () => {
  it("anchor not found → op error with hint", async () => {
    const p = await fixture("anchor.txt", "one\n");
    const text = [
      `File: ${p}`,
      "Action: replace",
      "<<<OLD",
      "missing",
      "OLD>>>",
      "<<<NEW",
      "x",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.status).toBe("error");
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[0]!.ops[0]!.hint).toBeDefined();
  });
});

describe("handleBatchEditText — stopOnError op level", () => {
  it("op.stopOnError=true under file.stopOnError=false: stops after that op fails", async () => {
    const p = await fixture("stop-op-true.txt", "A\n");
    const text = [
      `File: ${p}`,
      "stopOnError: false",
      "verbose: true",
      "Action: replace",
      "stopOnError: true",
      "<<<OLD",
      "ZZZ",
      "OLD>>>",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: append",
      "<<<NEW",
      "B",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[0]!.ops[1]!.status).toBe("skipped");
    const disk = await readText(p);
    expect(disk).toBe("A\n");
  });

  it("op.stopOnError=false under file.stopOnError=true: lets that op continue on failure", async () => {
    const p = await fixture("stop-op-false.txt", "A\n");
    const text = [
      `File: ${p}`,
      "stopOnError: true",
      "verbose: true",
      "Action: replace",
      "stopOnError: false",
      "<<<OLD",
      "ZZZ",
      "OLD>>>",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: append",
      "<<<NEW",
      "B",
      "NEW>>>",
    ].join("\n");
    const out = await handleBatchEditText({ content: text }, [workDir]);
    expect(out.results[0]!.ops[0]!.status).toBe("error");
    expect(out.results[0]!.ops[1]!.status).toBe("ok");
    const disk = await readText(p);
    expect(disk).toBe("A\nB\n");
  });
});
