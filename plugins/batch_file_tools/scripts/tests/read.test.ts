import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("offset and count respected; truncated flag set correctly", async () => {
    const p = await fixture("long.txt", "L1\nL2\nL3\nL4\nL5\n");
    const out = await read({
      requests: [{ path: p, mode: "verbatim_numbered", offset: 2, count: 2 }],
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

  it("relative paths resolve from cwd, not_authorized when outside allowed dirs", async () => {
    const out = await read({
      requests: [{ path: "relative/path.txt", mode: "verbatim_numbered" }],
    });
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("fileinfo returns size, line count, ISO mtime and no ctimeMs", async () => {
    const p = await fixture("info.ts", "const x = 1;\nconst y = 2;\n");
    const out = await read({ requests: [{ path: p, mode: "fileinfo" }] });
    const r = out.results[0]!;
    expect(r.mode_applied).toBe("fileinfo");
    const info = JSON.parse(r.content);
    expect(typeof info.size).toBe("number");
    expect(info.lines).toBe(2);
    expect(r.lines).toBe(2);
    expect(typeof info.mtime).toBe("string");
    expect(new Date(info.mtime).getTime()).toBeGreaterThan(0);
    expect(info.ctimeMs).toBeUndefined();
    expect(info.mtimeMs).toBeUndefined();
    expect(info.isFile).toBe(true);
    expect(info.refs).toBeUndefined();
  });

  it("fileinfo includes refs when file has imports", async () => {
    const p = await fixture("refs.ts", "import { foo } from './foo.js';\nimport bar from '../bar.js';\nimport 'react';\nconst x = 1;\n");
    const out = await read({ requests: [{ path: p, mode: "fileinfo" }] });
    const r = out.results[0]!;
    expect(r.mode_applied).toBe("fileinfo");
    const info = JSON.parse(r.content);
    expect(info.lines).toBe(4);
    expect(typeof info.mtime).toBe("string");
    expect(info.isFile).toBe(true);
    expect(Array.isArray(info.refs)).toBe(true);
    expect(info.refs).toContain(join(workDir, "foo.js"));
    expect(info.refs).toContain(resolve(workDir, "../bar.js"));
    expect(info.refs).not.toContain("react");
  });

  it("search: single match, no context", async () => {
    const p = await fixture("search.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim", searchTerm: "const b" }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(1);
    expect(r.content).toContain("<!-- Match at line 2 -->");
    expect(r.content).toContain("const b = 2;");
  });

  it("search: multiple matches", async () => {
    const p = await fixture("multi-search.ts", "foo();\nbar();\nfoo();\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim", searchTerm: "foo" }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(2);
    expect(r.content).toContain("<!-- Match at line 1 -->");
    expect(r.content).toContain("<!-- Match at line 3 -->");
  });

  it("search: multiple matches on the same line returns that line once", async () => {
    const p = await fixture("same-line.ts", "foo foo foo\nbar\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim", searchTerm: "foo" }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(1);
    expect(r.content.match(/<!-- Match at line/g)).toHaveLength(1);
  });

  it("search: no match returns match_count=0 and empty content", async () => {
    const p = await fixture("no-match.ts", "const x = 1;\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim", searchTerm: "zzznomatch" }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(0);
    expect(r.content).toBe("");
  });

  it("search: count controls context lines around match", async () => {
    const p = await fixture("ctx.ts", "line1\nline2\ntarget\nline4\nline5\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim", searchTerm: "target", count: 1 }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(1);
    expect(r.content).toContain("line2");
    expect(r.content).toContain("target");
    expect(r.content).toContain("line4");
    expect(r.content).not.toContain("line1");
  });

  it("glob read: expands to one result per matched file", async () => {
    const a = await fixture("glob_a.ts", "a\n");
    const b = await fixture("glob_b.ts", "b\n");
    await fixture("glob_c.txt", "c\n"); // should not match *.ts
    const out = await read({ requests: [{ path: `${workDir}/*.ts`, mode: "verbatim" }] });
    const paths = out.results.map(r => r.path).sort();
    expect(paths).toContain(a);
    expect(paths).toContain(b);
    expect(paths.some(p => p.endsWith(".txt"))).toBe(false);
  });

  it("glob read: verbatim_numbered expands and numbers each matched file independently", async () => {
    const a = await fixture("vng_a.ts", "hello\nworld\n");
    const b = await fixture("vng_b.ts", "foo\n");
    const out = await read({ requests: [{ path: `${workDir}/vng_*.ts`, mode: "verbatim_numbered" }] });
    const byPath = Object.fromEntries(out.results.map(r => [r.path, r]));
    expect(byPath[a]!.mode_applied).toBe("verbatim_numbered");
    expect(byPath[a]!.content).toBe("1\thello\n2\tworld\n");
    expect(byPath[b]!.mode_applied).toBe("verbatim_numbered");
    expect(byPath[b]!.content).toBe("1\tfoo\n");
  });

  it("folder read: verbatim_numbered expands directory to numbered results per file", async () => {
    const a = await fixture("vnf_a.ts", "alpha\n");
    const b = await fixture("vnf_b.ts", "beta\n");
    const out = await read({ requests: [{ path: workDir, mode: "verbatim_numbered" }] });
    const paths = out.results.map(r => r.path);
    expect(paths).toContain(a);
    expect(paths).toContain(b);
    const ra = out.results.find(r => r.path === a)!;
    expect(ra.mode_applied).toBe("verbatim_numbered");
    expect(ra.content).toBe("1\talpha\n");
  });

  it("folder read: expands to immediate children", async () => {
    const a = await fixture("dir_a.ts", "a\n");
    const b = await fixture("dir_b.ts", "b\n");
    const out = await read({ requests: [{ path: workDir, mode: "verbatim" }] });
    const paths = out.results.map(r => r.path);
    expect(paths).toContain(a);
    expect(paths).toContain(b);
  });

  it("search: verbatim_numbered uses absolute file line numbers in match blocks", async () => {
    const p = await fixture("search-numbered.ts", "line1\nline2\nline3\nTARGET\nline5\nline6\n");
    const out = await read({ requests: [{ path: p, mode: "verbatim_numbered", searchTerm: "TARGET", count: 1 }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(1);
    expect(r.content).toContain("<!-- Match at line 4 -->");
    // lines should be labeled with absolute file numbers 3, 4, 5
    expect(r.content).toContain("3\tline3");
    expect(r.content).toContain("4\tTARGET");
    expect(r.content).toContain("5\tline5");
  });

  it("search: compact mode collapses content in match blocks", async () => {
    const p = await fixture("search-compact.ts", "const   a   =   1;\nconst b = 2;\nconst   c   =   3;\n");
    const out = await read({ requests: [{ path: p, mode: "compact", searchTerm: "const b" }] });
    const r = out.results[0]!;
    expect(r.match_count).toBe(1);
    expect(r.content).toContain("<!-- Match at line 2 -->");
    // compact strips extra whitespace
    expect(r.content).toContain("const b = 2;");
  });

  it("search + glob: searchTerm applies to each file matched by glob", async () => {
    const a = await fixture("sg_a.ts", "alpha beta gamma\n");
    const b = await fixture("sg_b.ts", "delta epsilon\n");
    const out = await read({ requests: [{ path: `${workDir}/sg_*.ts`, mode: "verbatim", searchTerm: "beta" }] });
    const byPath = Object.fromEntries(out.results.map(r => [r.path, r]));
    expect(byPath[a]!.match_count).toBe(1);
    expect(byPath[b]!.match_count).toBe(0);
  });

  it("glob + fileinfo: returns metadata for each matched file", async () => {
    await fixture("fi_a.ts", "x\n");
    await fixture("fi_b.ts", "y\n");
    const out = await read({ requests: [{ path: `${workDir}/fi_*.ts`, mode: "fileinfo" }] });
    expect(out.results.length).toBe(2);
    for (const r of out.results) {
      expect(r.mode_applied).toBe("fileinfo");
      expect(JSON.parse(r.content).isFile).toBe(true);
    }
  });
});

describe("deduplication", () => {
  it("fileinfo: duplicate requests collapse to one result", async () => {
    const p = await fixture("dedup_fi.ts", "x\n");
    const out = await read({ requests: [{ path: p, mode: "fileinfo" }, { path: p, mode: "fileinfo" }] });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.mode_applied).toBe("fileinfo");
  });

  it("search: identical requests collapse to one result", async () => {
    const p = await fixture("dedup_search_dup.ts", "foo\nbar\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim", searchTerm: "foo" },
        { path: p, mode: "verbatim", searchTerm: "foo" },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.match_count).toBe(1);
  });

  it("search: same file different searchTerm keeps both", async () => {
    const p = await fixture("dedup_search_terms.ts", "foo\nbar\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim", searchTerm: "foo" },
        { path: p, mode: "verbatim", searchTerm: "bar" },
      ],
    });
    expect(out.results).toHaveLength(2);
  });

  it("search: same file same searchTerm different mode coalesces to verbatim", async () => {
    const p = await fixture("dedup_search_mode.ts", "foo\nbar\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim", searchTerm: "foo" },
        { path: p, mode: "compact", searchTerm: "foo" },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.mode_applied).toBe("verbatim");
    expect(out.results[0]!.match_count).toBe(1);
  });

  it("range: duplicate full-file requests collapse to one", async () => {
    const p = await fixture("dedup_range_full.ts", "L1\nL2\nL3\n");
    const out = await read({
      requests: [
        { path: p, mode: "compact" },
        { path: p, mode: "compact" },
      ],
    });
    expect(out.results).toHaveLength(1);
  });

  it("range: full-file subsumes partial slice", async () => {
    const p = await fixture("dedup_range_subsume.ts", "L1\nL2\nL3\nL4\nL5\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim" },
        { path: p, mode: "verbatim", offset: 2, count: 2 },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.returned_lines).toBe(5);
  });

  it("range: overlapping slices merge to union range", async () => {
    const p = await fixture("dedup_range_overlap.ts", "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim_numbered", offset: 1, count: 6 },
        { path: p, mode: "verbatim_numbered", offset: 4, count: 6 },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.returned_lines).toBe(9);
    expect(out.results[0]!.content).toContain("1\tL1");
    expect(out.results[0]!.content).toContain("9\tL9");
  });

  it("range: adjacent slices merge", async () => {
    const p = await fixture("dedup_range_adj.ts", "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim_numbered", offset: 1, count: 4 },
        { path: p, mode: "verbatim_numbered", offset: 5, count: 4 },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.returned_lines).toBe(8);
  });

  it("range: non-overlapping slices stay separate", async () => {
    const p = await fixture("dedup_range_sep.ts", "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim_numbered", offset: 1, count: 3 },
        { path: p, mode: "verbatim_numbered", offset: 7, count: 3 },
      ],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.returned_lines).toBe(3);
    expect(out.results[1]!.returned_lines).toBe(3);
  });

  it("mode: mixed compact+verbatim coalesces to verbatim", async () => {
    const p = await fixture("dedup_mode_mix.ts", "const   a = 1;\n");
    const out = await read({
      requests: [
        { path: p, mode: "compact" },
        { path: p, mode: "verbatim" },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.mode_applied).toBe("verbatim");
    expect(out.results[0]!.content).toBe("const   a = 1;\n");
  });

  it("mode: verbatim_numbered slices with no overlap stay verbatim_numbered", async () => {
    const p = await fixture("dedup_mode_vn.ts", "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n");
    const out = await read({
      requests: [
        { path: p, mode: "verbatim_numbered", offset: 1, count: 3 },
        { path: p, mode: "verbatim_numbered", offset: 7, count: 3 },
      ],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.mode_applied).toBe("verbatim_numbered");
    expect(out.results[1]!.mode_applied).toBe("verbatim_numbered");
  });

  it("mode: verbatim_numbered merged to full-file downgrades to verbatim", async () => {
    const p = await fixture("dedup_mode_vn_full.ts", "L1\nL2\nL3\nL4\nL5\n");
    // offset:3 with no count = [3, Infinity]; offset:1,count:4 = [1,4]; merged = [1, Infinity]
    const out = await read({
      requests: [
        { path: p, mode: "verbatim_numbered", offset: 1, count: 4 },
        { path: p, mode: "verbatim_numbered", offset: 3 },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.mode_applied).toBe("verbatim");
    expect(out.results[0]!.returned_lines).toBe(5);
    expect(out.results[0]!.content).not.toContain("1\t");
  });

  it("same file via symlink deduplicates", async () => {
    const p = await fixture("symlink_target.ts", "hello\n");
    const link = join(workDir, "symlink_link.ts");
    try {
      await symlink(p, link);
    } catch {
      return; // symlink creation not supported on this platform/config
    }
    const out = await read({
      requests: [
        { path: p, mode: "verbatim" },
        { path: link, mode: "verbatim" },
      ],
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.content).toBe("hello\n");
  });

  it("glob + explicit: same resolved path deduplicates", async () => {
    const p = await fixture("dedup_glob_explicit.ts", "hello\n");
    const out = await read({
      requests: [
        { path: `${workDir}/dedup_glob_explicit.ts`, mode: "verbatim" },
        { path: p, mode: "verbatim" },
      ],
    });
    expect(out.results).toHaveLength(1);
  });

  it("disableNormalizedFormatting: different values produce separate results", async () => {
    const p = await fixture("dedup_norm.ts", "  const a = 1;\n");
    const out = await read({
      requests: [
        { path: p, mode: "compact" },
        { path: p, mode: "compact", disableNormalizedFormatting: true },
      ],
    });
    expect(out.results).toHaveLength(2);
  });

  it("different files: not merged", async () => {
    const a = await fixture("dedup_diff_a.ts", "A\n");
    const b = await fixture("dedup_diff_b.ts", "B\n");
    const out = await read({
      requests: [
        { path: a, mode: "verbatim" },
        { path: b, mode: "verbatim" },
      ],
    });
    expect(out.results).toHaveLength(2);
  });

  it("errors pass through alongside deduped ok results", async () => {
    const p = await fixture("dedup_err_ok.ts", "hi\n");
    const missing = join(workDir, "dedup_missing.ts");
    const out = await read({
      requests: [
        { path: missing, mode: "verbatim" },
        { path: p, mode: "verbatim" },
        { path: p, mode: "verbatim" },
      ],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results.filter(r => r.error?.reason === "not_found")).toHaveLength(1);
    expect(out.results.filter(r => !r.error)).toHaveLength(1);
  });
});
