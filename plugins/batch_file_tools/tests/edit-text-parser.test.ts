import { describe, expect, it } from "vitest";
import { parseEditText } from "../src/lib/edit-text-parser.js";
import type { EditOp } from "../src/types.js";

function okFile(result: ReturnType<typeof parseEditText>, idx: number) {
  const e = result.entries[idx]!;
  if (e.kind !== "ok") throw new Error(`entries[${idx}] not ok: ${JSON.stringify(e)}`);
  return e.parsed;
}

function badFile(result: ReturnType<typeof parseEditText>, idx: number) {
  const e = result.entries[idx]!;
  if (e.kind !== "unparseable") throw new Error(`entries[${idx}] not unparseable`);
  return e;
}

describe("parseEditText — root scalars", () => {
  it("parses stopOnError, dryRun, verbose at root before any File:", () => {
    const text = [
      "stopOnError: true",
      "dryRun: false",
      "verbose: true",
      "",
      "File: C:/p/a.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "x",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.stopOnError).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(r.verbose).toBe(true);
    expect(r.entries).toHaveLength(1);
  });

  it("missing root scalars stay undefined", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.stopOnError).toBeUndefined();
    expect(r.dryRun).toBeUndefined();
    expect(r.verbose).toBeUndefined();
  });

  it("blank lines between root scalars are ignored", () => {
    const text = [
      "stopOnError: true",
      "",
      "",
      "verbose: false",
      "File: C:/p/a.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.stopOnError).toBe(true);
    expect(r.verbose).toBe(false);
  });

  it("strict booleans only — '1' / 'yes' rejected", () => {
    const text = [
      "stopOnError: yes",
      "File: C:/p/a.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.rootError).toBeDefined();
    expect(r.rootError?.message).toMatch(/boolean/i);
  });

  it("missing File: header at all → rootError", () => {
    const text = "stopOnError: true\nverbose: false\n";
    const r = parseEditText(text);
    expect(r.rootError).toBeDefined();
    expect(r.entries).toHaveLength(0);
  });
});

describe("parseEditText — replace / replace_all", () => {
  it("parses replace with OLD + NEW", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "old text",
      "OLD>>>",
      "<<<NEW",
      "new text",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    const f = okFile(r, 0);
    expect(f.file.path).toBe("C:/p/a.txt");
    expect(f.file.ops).toHaveLength(1);
    const op = f.file.ops[0]! as Extract<EditOp, { type: "replace" }>;
    expect(op.type).toBe("replace");
    expect(op.old).toBe("old text");
    expect(op.new).toBe("new text");
  });

  it("parses replace_all", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace_all",
      "<<<OLD",
      "x",
      "OLD>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    const op = okFile(r, 0).file.ops[0]!;
    expect(op.type).toBe("replace_all");
  });

  it("multi-line OLD and NEW preserve newlines verbatim", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "line1",
      "line2",
      "line3",
      "OLD>>>",
      "<<<NEW",
      "new1",
      "new2",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    const op = okFile(r, 0).file.ops[0]! as Extract<EditOp, { type: "replace" }>;
    expect(op.old).toBe("line1\nline2\nline3");
    expect(op.new).toBe("new1\nnew2");
  });

  it("empty NEW (delete text) is allowed", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "delete me",
      "OLD>>>",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    const op = okFile(r, 0).file.ops[0]! as Extract<EditOp, { type: "replace" }>;
    expect(op.new).toBe("");
  });

  it("empty OLD → unparseable op (schema requires min(1))", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "OLD>>>",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    const f = okFile(r, 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
    expect(f.file.ops).toHaveLength(1);
  });

  it("missing NEW fence before next Action → unparseable op via look-back recovery", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "x",
      "OLD>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    const f = okFile(r, 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
    expect(f.file.ops).toHaveLength(1);
    expect(f.file.ops[0]!.type).toBe("write");
  });
});

describe("parseEditText — insert_at_line", () => {
  it("parses insert_at_line with line: scalar + NEW fence", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: insert_at_line",
      "line: 42",
      "<<<NEW",
      "inserted",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "insert_at_line" }>;
    expect(op.type).toBe("insert_at_line");
    expect(op.line).toBe(42);
    expect(op.content).toBe("inserted");
  });

  it("missing line: → unparseable", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: insert_at_line",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
  });

  it("non-positive line → unparseable", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: insert_at_line",
      "line: 0",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
  });
});

describe("parseEditText — replace_range", () => {
  it("parses replace_range with start/end + NEW", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace_range",
      "start: 10",
      "end: 25",
      "<<<NEW",
      "replacement",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "replace_range" }>;
    expect(op.type).toBe("replace_range");
    expect(op.start).toBe(10);
    expect(op.end).toBe(25);
    expect(op.content).toBe("replacement");
  });

  it("missing end: → unparseable", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace_range",
      "start: 10",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
  });

  it("empty replacement content allowed", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace_range",
      "start: 1",
      "end: 3",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "replace_range" }>;
    expect(op.content).toBe("");
  });
});

describe("parseEditText — write", () => {
  it("parses write overwrite", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "full content",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "write" }>;
    expect(op.type).toBe("write");
    expect(op.mode).toBe("overwrite");
    expect(op.content).toBe("full content");
  });

  it("parses write append", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "mode: append",
      "<<<NEW",
      "appended",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "write" }>;
    expect(op.mode).toBe("append");
  });

  it("empty content allowed for overwrite (truncate)", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "write" }>;
    expect(op.content).toBe("");
  });

  it("invalid mode → unparseable", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "mode: replace",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: append",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
  });
});

describe("parseEditText — file & action scalars", () => {
  it("file-level stopOnError + verbose", () => {
    const text = [
      "File: C:/p/a.txt",
      "stopOnError: true",
      "verbose: false",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "x",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0).file;
    expect(f.stopOnError).toBe(true);
    expect(f.verbose).toBe(false);
  });

  it("action-level verbose", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "verbose: true",
      "mode: overwrite",
      "<<<NEW",
      "x",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]!;
    expect(op.verbose).toBe(true);
  });

  it("scalars in any order before fence", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace_range",
      "verbose: true",
      "end: 5",
      "start: 1",
      "<<<NEW",
      "x",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "replace_range" }>;
    expect(op.start).toBe(1);
    expect(op.end).toBe(5);
    expect(op.verbose).toBe(true);
  });
});

describe("parseEditText — multi-file, multi-op", () => {
  it("two files with mixed actions", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "x",
      "OLD>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
      "Action: write",
      "mode: append",
      "<<<NEW",
      "tail",
      "NEW>>>",
      "File: C:/p/b.txt",
      "Action: insert_at_line",
      "line: 1",
      "<<<NEW",
      "top",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.entries).toHaveLength(2);
    expect(okFile(r, 0).file.path).toBe("C:/p/a.txt");
    expect(okFile(r, 0).file.ops).toHaveLength(2);
    expect(okFile(r, 1).file.path).toBe("C:/p/b.txt");
    expect(okFile(r, 1).file.ops).toHaveLength(1);
  });

  it("preserves Windows path with C:/...", () => {
    const text = [
      "File: C:/Users/X/foo.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    expect(okFile(parseEditText(text), 0).file.path).toBe("C:/Users/X/foo.txt");
  });

  it("preserves glob path", () => {
    const text = [
      "File: C:/proj/**/*.ts",
      "Action: replace",
      "<<<OLD",
      "x",
      "OLD>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    expect(okFile(parseEditText(text), 0).file.path).toBe("C:/proj/**/*.ts");
  });

  it("path with trailing whitespace is trimmed", () => {
    const text = [
      "File: C:/p/a.txt   ",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "NEW>>>",
    ].join("\n");
    expect(okFile(parseEditText(text), 0).file.path).toBe("C:/p/a.txt");
  });
});

describe("parseEditText — sentinel collision suffix", () => {
  it("supports <<<OLD#xyz / OLD#xyz>>> when content contains OLD>>>", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD#k1",
      "OLD>>>",
      "OLD#k1>>>",
      "<<<NEW#k2",
      "NEW>>>",
      "NEW#k2>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "replace" }>;
    expect(op.old).toBe("OLD>>>");
    expect(op.new).toBe("NEW>>>");
  });

  it("mismatched suffix → fence treated as unclosed", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD#abc",
      "x",
      "OLD#xyz>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "z",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
  });
});

describe("parseEditText — fence/header column rules", () => {
  it("indented sentinel is content, not fence", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "  <<<OLD",
      "  OLD>>>",
      "OLD>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "replace" }>;
    expect(op.old).toBe("  <<<OLD\n  OLD>>>");
  });

  it("indented File:/Action: inside fence is content", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "  File: x.txt",
      "  Action: write",
      "OLD>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const op = okFile(parseEditText(text), 0).file.ops[0]! as Extract<EditOp, { type: "replace" }>;
    expect(op.old).toBe("  File: x.txt\n  Action: write");
  });
});

describe("parseEditText — recovery", () => {
  it("unclosed OLD fence followed by valid Action+fence: previous op unparseable, recovery resumes", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "x",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "recovered",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
    expect(f.file.ops).toHaveLength(1);
    expect(f.file.ops[0]!.type).toBe("write");
  });

  it("unclosed fence with no recovery anchor → file-level unparseable", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "no recovery",
    ].join("\n");
    const r = parseEditText(text);
    const e = badFile(r, 0);
    expect(e.path).toBe("C:/p/a.txt");
  });

  it("file-level recovery: bad file followed by good file", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "unclosed",
      "File: C:/p/b.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "ok",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.entries).toHaveLength(2);
    badFile(r, 0);
    const second = okFile(r, 1);
    expect(second.file.path).toBe("C:/p/b.txt");
  });

  it("File: with empty path → unparseable file entry, recovery to next File:", () => {
    const text = [
      "File: ",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "x",
      "NEW>>>",
      "File: C:/p/b.txt",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const r = parseEditText(text);
    expect(r.entries).toHaveLength(2);
    badFile(r, 0);
    expect(okFile(r, 1).file.path).toBe("C:/p/b.txt");
  });

  it("opSlots length matches total Action: blocks declared in file", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "x",
      "OLD>>>",
      "<<<NEW",
      "y",
      "NEW>>>",
      "Action: insert_at_line",
      "<<<NEW",
      "no line scalar",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "z",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots).toHaveLength(3);
    expect(f.opSlots[0]!.status).toBe("ok");
    expect(f.opSlots[1]!.status).toBe("unparseable");
    expect(f.opSlots[2]!.status).toBe("ok");
    expect(f.file.ops).toHaveLength(2);
  });
});

describe("parseEditText — error details", () => {
  it("unparseable op carries line number in error", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: insert_at_line",
      "<<<NEW",
      "missing line scalar",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    const slot0 = f.opSlots[0]!;
    if (slot0.status !== "unparseable") throw new Error("expected unparseable");
    expect(slot0.error.line).toBeGreaterThan(0);
    expect(slot0.error.message.length).toBeGreaterThan(0);
  });

  it("unparseable file carries line number", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: replace",
      "<<<OLD",
      "never closes",
    ].join("\n");
    const e = badFile(parseEditText(text), 0);
    expect(e.error.line).toBeGreaterThan(0);
  });
});

describe("parseEditText — unknown action/scalar", () => {
  it("unknown Action type → unparseable op", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: bogus",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
  });

  it("unknown scalar inside action → unparseable op", () => {
    const text = [
      "File: C:/p/a.txt",
      "Action: write",
      "bogus: 1",
      "mode: overwrite",
      "<<<NEW",
      "x",
      "NEW>>>",
      "Action: write",
      "mode: overwrite",
      "<<<NEW",
      "y",
      "NEW>>>",
    ].join("\n");
    const f = okFile(parseEditText(text), 0);
    expect(f.opSlots[0]!.status).toBe("unparseable");
    expect(f.opSlots[1]!.status).toBe("ok");
  });
});
