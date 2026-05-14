import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleBatchEdit } from "../src/tools/edit.js";
import type { EditFile, EditOp } from "../src/types.js";

let workDir: string;
let counter = 0;

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "btf-edit-")));
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

async function runEdit(file: EditFile) {
  return handleBatchEdit({
    dryRun: false,
    files: [file],
  }, [workDir]);
}

async function readText(path: string): Promise<string> {
  return readFile(path, { encoding: "utf8" });
}

describe("write op — create new file", () => {
  it("creates a new file with content", async () => {
    const p = tmpPath("new.txt");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "overwrite", content: "hello\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("hello\n");
  });

  it("auto-creates missing parent directories", async () => {
    const p = join(workDir, `${counter}-nested/sub/dir/file.txt`);
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "overwrite", content: "x\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(existsSync(p)).toBe(true);
  });

  it("empty content produces empty file", async () => {
    const p = tmpPath("empty.txt");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "overwrite", content: "" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("");
  });
});

describe("write op — overwrite existing", () => {
  it("replaces existing content", async () => {
    const p = await fixture("ow.txt", "line1\nline2\nline3\n");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "overwrite", content: "only\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("only\n");
  });

  it("creates file if missing", async () => {
    const p = tmpPath("ow_new.txt");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "overwrite", content: "x\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("x\n");
  });
});

describe("write op — append", () => {
  it("appends to EOF of existing file", async () => {
    const p = await fixture("app.txt", "a\nb\n");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "append", content: "c\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("a\nb\nc\n");
  });

  it("creates file if missing", async () => {
    const p = tmpPath("app_new.txt");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "append", content: "hi\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("hi\n");
  });

  it("appends literally — no implicit newline when file has no trailing newline", async () => {
    const p = await fixture("no_nl.txt", "abc");
    const out = await runEdit({ path: p, ops: [{ type: "write", mode: "append", content: "def\n" }] });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("abcdef\n");
  });
});

describe("insert_at_line op", () => {
  it("inserts before the given line, shifting subsequent lines down", async () => {
    const p = await fixture("ins.txt", "A\nB\nC\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "insert_at_line", line: 2, content: "X\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("A\nX\nB\nC\n");
  });

  it("line = lines.length + 1 appends at EOF", async () => {
    const p = await fixture("ins_eof.txt", "A\nB\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "insert_at_line", line: 3, content: "C\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("A\nB\nC\n");
  });

  it("out-of-range line returns invalid_range", async () => {
    const p = await fixture("ins_bad.txt", "A\nB\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "insert_at_line", line: 99, content: "X\n" }],
    });
    const op = out.results[0]!.ops[0]!;
    expect(op.status).toBe("error");
    expect(op.reason).toBe("invalid_range");
    expect(await readText(p)).toBe("A\nB\n"); // unchanged
  });

  it("content without trailing newline still inserts as a full line", async () => {
    const p = await fixture("ins_nonl.txt", "A\nB\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "insert_at_line", line: 2, content: "X" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("A\nX\nB\n");
  });

  it("CRLF file: inserted content without newline inherits CRLF", async () => {
    const p = await fixture("ins_crlf.txt", "A\r\nB\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "insert_at_line", line: 2, content: "X" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("A\r\nX\r\nB\r\n");
  });
});

describe("replace_range op", () => {
  it("replaces lines start..end inclusive", async () => {
    const p = await fixture("rr.txt", "1\n2\n3\n4\n5\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_range", start: 2, end: 4, content: "X\nY\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("1\nX\nY\n5\n");
  });

  it("end < start returns invalid_range", async () => {
    const p = await fixture("rr_bad.txt", "A\nB\nC\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_range", start: 3, end: 1, content: "x\n" }],
    });
    expect(out.results[0]!.ops[0]!.reason).toBe("invalid_range");
  });

  it("end beyond EOF returns invalid_range", async () => {
    const p = await fixture("rr_oob.txt", "A\nB\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_range", start: 1, end: 99, content: "x\n" }],
    });
    expect(out.results[0]!.ops[0]!.reason).toBe("invalid_range");
  });
});

describe("phased execution order", () => {
  it("phase-1 line-addressed ops reference original-file line numbers regardless of input order", async () => {
    // Buffer has 5 lines. Multiple line-addressed ops all reference original lines —
    // without desc ordering, the second op would see a shifted buffer.
    const p = await fixture("phase1.txt", "1\n2\n3\n4\n5\n");
    const ops: EditOp[] = [
      { type: "insert_at_line", line: 2, content: "INS2\n" }, // before original line 2
      { type: "replace_range", start: 4, end: 5, content: "REPL\n" }, // original lines 4-5
    ];
    const out = await runEdit({ path: p, ops });
    expect(out.results[0]!.ops.every((o) => o.status === "ok")).toBe(true);
    expect(await readText(p)).toBe("1\nINS2\n2\n3\nREPL\n");
  });

  it("phase-2 content ops see post-phase-1 buffer and run in input order", async () => {
    const p = await fixture("phase2.txt", "A\nB\nC\n");
    const ops: EditOp[] = [
      { type: "write", mode: "append", content: "TAIL\n" },
      { type: "insert_at_line", line: 1, content: "HEAD\n" }, // phase 1
      { type: "replace", old: "B", new: "BEE" },
    ];
    const out = await runEdit({ path: p, ops });
    expect(out.results[0]!.ops.every((o) => o.status === "ok")).toBe(true);
    expect(await readText(p)).toBe("HEAD\nA\nBEE\nC\nTAIL\n");
  });

  it("overlapping replace_range ops: both error with invalid_range", async () => {
    const p = await fixture("overlap-rr.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    const out = await runEdit({
      path: p,
      ops: [
        { type: "replace_range", start: 2, end: 5, content: "X\n" },
        { type: "replace_range", start: 4, end: 7, content: "Y\n" },
      ],
    });
    const ops = out.results[0]!.ops;
    expect(ops[0]!.status).toBe("error");
    expect(ops[0]!.reason).toBe("invalid_range");
    expect(ops[0]!.hint?.next_action).toMatch(/overlaps with op at index 1/);
    expect(ops[1]!.status).toBe("error");
    expect(ops[1]!.hint?.next_action).toMatch(/overlaps with op at index 0/);
    expect(await readText(p)).toBe("1\n2\n3\n4\n5\n6\n7\n8\n"); // unchanged
  });

  it("insert_at_line inside a replace_range: both error", async () => {
    const p = await fixture("overlap-ins.txt", "1\n2\n3\n4\n5\n");
    const out = await runEdit({
      path: p,
      ops: [
        { type: "replace_range", start: 2, end: 4, content: "X\n" },
        { type: "insert_at_line", line: 3, content: "Y\n" },
      ],
    });
    const ops = out.results[0]!.ops;
    expect(ops[0]!.reason).toBe("invalid_range");
    expect(ops[1]!.reason).toBe("invalid_range");
    expect(await readText(p)).toBe("1\n2\n3\n4\n5\n");
  });

  it("insert_at_line at replace_range end+1 does NOT overlap", async () => {
    const p = await fixture("boundary.txt", "1\n2\n3\n4\n5\n");
    const out = await runEdit({
      path: p,
      ops: [
        { type: "replace_range", start: 2, end: 3, content: "X\n" },
        { type: "insert_at_line", line: 4, content: "Y\n" },
      ],
    });
    expect(out.results[0]!.ops.every((o) => o.status === "ok")).toBe(true);
    expect(await readText(p)).toBe("1\nX\nY\n4\n5\n");
  });

  it("two inserts at same line error (ambiguous order)", async () => {
    const p = await fixture("dup-ins.txt", "A\nB\n");
    const out = await runEdit({
      path: p,
      ops: [
        { type: "insert_at_line", line: 2, content: "X\n" },
        { type: "insert_at_line", line: 2, content: "Y\n" },
      ],
    });
    expect(out.results[0]!.ops[0]!.reason).toBe("invalid_range");
    expect(out.results[0]!.ops[1]!.reason).toBe("invalid_range");
    expect(await readText(p)).toBe("A\nB\n");
  });

  it("failing phase-1 op aborts remaining phase-1 and phase-2 ops (input order preserved in result)", async () => {
    const p = await fixture("abort.txt", "A\nB\n");
    const ops: EditOp[] = [
      { type: "insert_at_line", line: 1, content: "X\n" }, // phase 1, line 1
      { type: "insert_at_line", line: 99, content: "Y\n" }, // phase 1, line 99 — fails first (desc sort)
      { type: "write", mode: "append", content: "Z\n" }, // phase 2, skipped
    ];
    const out = await runEdit({ path: p, stopOnError: true, ops });
    const ops_out = out.results[0]!.ops;
    // Execution order: line 99 first (error) → line 1 skipped → append skipped.
    // Result maps back to input order: [skipped, error, skipped].
    expect(ops_out[0]!.status).toBe("skipped");
    expect(ops_out[1]!.status).toBe("error");
    expect(ops_out[1]!.reason).toBe("invalid_range");
    expect(ops_out[2]!.status).toBe("skipped");
    expect(await readText(p)).toBe("A\nB\n"); // unchanged
  });

  it("phase-2 ops apply in input order against post-previous state", async () => {
    const p = await fixture("p2-seq.txt", "hello\n");
    const ops: EditOp[] = [
      { type: "write", mode: "append", content: "world\n" },
      { type: "replace", old: "world", new: "WORLD" },
    ];
    const out = await runEdit({ path: p, ops });
    expect(out.results[0]!.ops.every((o) => o.status === "ok")).toBe(true);
    expect(await readText(p)).toBe("hello\nWORLD\n");
  });
});

describe("replace op", () => {
  it("replaces a unique string", async () => {
    const p = await fixture("rep.txt", "foo bar baz\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "bar", new: "QUX" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("foo QUX baz\n");
  });

  it("not_found when the string isn't present", async () => {
    const p = await fixture("rep_nf.txt", "a\nb\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "ZZZ_totally_unrelated_1234", new: "YYY" }],
    });
    const op = out.results[0]!.ops[0]!;
    expect(op.status).toBe("error");
    expect(op.reason).toBe("not_found");
    expect(op.hint?.nearest_anchor).toBeUndefined();
    expect(await readText(p)).toBe("a\nb\n");
  });

  it("not_found populates nearest_anchor when a similar line exists", async () => {
    const p = await fixture(
      "rep_near.txt",
      "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n",
    );
    const out = await runEdit({
      path: p,
      // typo: 'betta' instead of 'beta'
      ops: [{ type: "replace", old: "function betta()", new: "function gamma()" }],
    });
    const op = out.results[0]!.ops[0]!;
    expect(op.reason).toBe("not_found");
    expect(op.hint?.nearest_anchor).toBeDefined();
    const anchor = op.hint!.nearest_anchor!;
    expect(anchor.start_line).toBeLessThanOrEqual(4);
    expect(anchor.end_line).toBeGreaterThanOrEqual(4);
    // The anchor content must appear verbatim in the file (usable as edit anchor).
    const fileContent = await readText(p);
    expect(fileContent.includes(anchor.content)).toBe(true);
    // And be unique.
    expect(fileContent.indexOf(anchor.content, fileContent.indexOf(anchor.content) + 1)).toBe(-1);
    expect(op.hint?.next_action).toMatch(/nearest similar line is 4/);
  });

  it("ambiguous returns match_lines", async () => {
    const p = await fixture("rep_amb.txt", "foo\nbar\nfoo\nbaz\nfoo\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "foo", new: "X" }],
    });
    const op = out.results[0]!.ops[0]!;
    expect(op.status).toBe("error");
    expect(op.reason).toBe("ambiguous");
    expect(op.hint?.match_lines).toEqual([1, 3, 5]);
    expect(await readText(p)).toBe("foo\nbar\nfoo\nbaz\nfoo\n");
  });

  it("preserves CRLF line endings around the replacement", async () => {
    const p = await fixture("rep_crlf.txt", "a\r\nOLD\r\nb\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "OLD", new: "NEW" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("a\r\nNEW\r\nb\r\n");
  });

  it("multi-line old is supported", async () => {
    const p = await fixture("rep_ml.txt", "a\nB1\nB2\nc\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "B1\nB2", new: "X" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("a\nX\nc\n");
  });
});

describe("replace_all op", () => {
  it("replaces every occurrence", async () => {
    const p = await fixture("ra.txt", "foo bar foo baz foo\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_all", old: "foo", new: "X" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("X bar X baz X\n");
  });

  it("not_found when missing", async () => {
    const p = await fixture("ra_nf.txt", "abc\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_all", old: "zzz", new: "x" }],
    });
    expect(out.results[0]!.ops[0]!.reason).toBe("not_found");
  });

  it("safe when new contains old (no infinite loop, no double-replace)", async () => {
    const p = await fixture("ra_overlap.txt", "aaa\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_all", old: "a", new: "aa" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("aaaaaa\n"); // 3 a's -> 6 a's (each replaced once)
  });
});

describe("delete via replace(new='')", () => {
  it("deletes a unique anchor", async () => {
    const p = await fixture("del.txt", "keep\nDROP\nkeep\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "DROP\n", new: "" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("keep\nkeep\n");
  });

  it("ambiguous anchor fails without modifying file", async () => {
    const p = await fixture("del_amb.txt", "X\nY\nX\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "X", new: "" }],
    });
    expect(out.results[0]!.ops[0]!.reason).toBe("ambiguous");
    expect(await readText(p)).toBe("X\nY\nX\n");
  });
});

describe("batch across multiple files", () => {
  it("each file gets its own buffer and write", async () => {
    const a = await fixture("ba.txt", "A\n");
    const b = await fixture("bb.txt", "B\n");
    const out = await handleBatchEdit({
      dryRun: false,
      files: [
        { path: a, ops: [{ type: "write", mode: "append", content: "A2\n" }] },
        { path: b, ops: [{ type: "write", mode: "append", content: "B2\n" }] },
      ],
    }, [workDir]);
    expect(out.results).toHaveLength(2);
    expect(await readText(a)).toBe("A\nA2\n");
    expect(await readText(b)).toBe("B\nB2\n");
  });
});

describe("line-ending auto-match", () => {
  it("replace: LF needle matches CRLF file and preserves CRLF on splice", async () => {
    const p = await fixture("crlf-replace.txt", "alpha\r\nbeta\r\ngamma\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "beta", new: "BETA" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("replace: multi-line LF needle matches CRLF file", async () => {
    const p = await fixture("crlf-multi.txt", "a\r\nb\r\nc\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "a\nb", new: "X\nY" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    // Replacement \n converts to file dominant CRLF.
    expect(await readText(p)).toBe("X\r\nY\r\nc\r\n");
  });

  it("replace: CRLF needle matches LF file and preserves LF on splice", async () => {
    const p = await fixture("lf-crlfneedle.txt", "a\nb\nc\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "a\r\nb", new: "X\r\nY" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("X\nY\nc\n");
  });

  it("replace_all: LF needle finds every CRLF occurrence", async () => {
    const p = await fixture("crlf-all.txt", "x\r\nx\r\nx\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_all", old: "x", new: "Y" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("Y\r\nY\r\nY\r\n");
  });

  it("delete via replace: LF needle removes the matched CRLF segment", async () => {
    const p = await fixture("crlf-del.txt", "keep\r\ndrop\r\nkeep\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace", old: "drop\n", new: "" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("keep\r\nkeep\r\n");
  });

  it("append: multi-line LF content into CRLF file converts to CRLF", async () => {
    const p = await fixture("crlf-append.txt", "head\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "write", mode: "append", content: "x\ny\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("head\r\nx\r\ny\r\n");
  });

  it("insert_at_line: LF content into CRLF file converts to CRLF", async () => {
    const p = await fixture("crlf-insert.txt", "A\r\nB\r\nC\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "insert_at_line", line: 2, content: "X\nY\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("A\r\nX\r\nY\r\nB\r\nC\r\n");
  });

  it("replace_range: LF content into CRLF file converts to CRLF", async () => {
    const p = await fixture("crlf-range.txt", "1\r\n2\r\n3\r\n");
    const out = await runEdit({
      path: p,
      ops: [{ type: "replace_range", start: 2, end: 2, content: "X\nY\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("1\r\nX\r\nY\r\n3\r\n");
  });

  it("write(overwrite) new file: preserves whatever endings the model supplied (no auto-conversion)", async () => {
    const p = tmpPath("create-mixed.txt");
    const out = await runEdit({
      path: p,
      ops: [{ type: "write", mode: "overwrite", content: "a\r\nb\nc\r\n" }],
    });
    expect(out.results[0]!.status).toBe("ok");
    expect(await readText(p)).toBe("a\r\nb\nc\r\n");
  });
});
