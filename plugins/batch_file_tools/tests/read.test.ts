import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleBatchRead } from "../src/tools/read.js";
import type { ReadInput } from "../src/types.js";

let workDir: string;

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "btf-read-")));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const p = join(workDir, name);
  await writeFile(p, content, { encoding: "utf8" });
  return p;
}

async function read(input: ReadInput) {
  return handleBatchRead(input, [workDir]);
}

describe("handleBatchRead", () => {
  it("reads a single file in edit mode with line numbers", async () => {
    const p = await fixture("a.txt", "one\ntwo\nthree\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim_numbered" }] });
    expect(out.results).toHaveLength(1);
    const r = out.results[0]!;
    expect(r.path).toBe(p);
    expect(r.mode_applied).toBe("verbatim_numbered");
    expect(r.lines).toBe(3);
    expect(r.returned_lines).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("1\tone\n2\ttwo\n3\tthree\n");
    expect(r.error).toBeUndefined();
  });

  it("reads multiple files in one call, preserving order", async () => {
    const a = await fixture("multi_a.txt", "A1\nA2\n");
    const b = await fixture("multi_b.txt", "B1\n");
    const out = await read({
      requests: [
        { path: a, mode: "verbatim" },
        { path: b, mode: "verbatim_numbered" },
      ],
    });
    expect(out.results.map((r) => r.path)).toEqual([a, b]);
    expect(out.results[0]!.content).toBe("A1\nA2\n");
    expect(out.results[1]!.content).toBe("1\tB1\n");
  });

  it("raw mode preserves CRLF byte-exactly", async () => {
    const p = await fixture("crlf.txt", "x\r\ny\r\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim" }] });
    expect(out.results[0]!.content).toBe("x\r\ny\r\n");
  });

  it("offset and limit respected; truncated flag set correctly", async () => {
    const p = await fixture("long.txt", "L1\nL2\nL3\nL4\nL5\n");
    const out = await read({
      requests: [{ path: p, mode: "verbatim_numbered", offset: 2, limit: 2 }],
    });
    const r = out.results[0]!;
    expect(r.content).toBe("2\tL2\n3\tL3\n");
    expect(r.lines).toBe(5);
    expect(r.returned_lines).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("missing file returns an error entry, not a throw", async () => {
    const missing = join(workDir, "does_not_exist.txt");
    const out = await read({
      requests: [{ path: missing, mode: "verbatim_numbered" }],
    });
    const r = out.results[0]!;
    expect(r.content).toBeDefined();
    expect(r.error?.reason).toBe("not_found");
    expect(r.lines).toBe(0);
  });

  it("batch continues through missing files", async () => {
    const ok = await fixture("ok.txt", "hi\n");
    const missing = join(workDir, "nope.txt");
    const out = await read({
      requests: [
        { path: missing, mode: "verbatim_numbered" },
        { path: ok, mode: "verbatim_numbered" },
      ],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.error?.reason).toBe("not_found");
    expect(out.results[1]!.content).toBe("1\thi\n");
  });

  it("compact mode on non-indent-sensitive file collapses to single line", async () => {
    const p = await fixture("compact.ts", "const a = 1;\n\n\nconst b = 2;\n");
    const out = await read({
      requests: [{ path: p, mode: "compact" }],
    });
    const r = out.results[0]!;
    expect(r.mode_applied).toBe("compact");
    expect(r.content).toBe("const a = 1; const b = 2;");
    expect(r.lines).toBe(4);
    expect(r.returned_lines).toBe(1);
  });

  it("rejects non-absolute paths", async () => {
    const out = await read({
      requests: [{ path: "relative/path.txt", mode: "verbatim_numbered" }],
    });
    expect(out.results[0]!.error?.reason).toBe("not_absolute");
  });
});
