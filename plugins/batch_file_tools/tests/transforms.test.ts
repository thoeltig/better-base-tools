import { describe, expect, it } from "vitest";
import { formatForRead } from "../src/lib/transforms.js";

const SAMPLE = "alpha\nbeta\ngamma\ndelta\n";

describe("formatForRead — edit mode", () => {
  it("prefixes each line with 1-indexed number + tab", () => {
    const r = formatForRead({ content: SAMPLE, mode: "edit" });
    expect(r.content).toBe("1\talpha\n2\tbeta\n3\tgamma\n4\tdelta\n");
    expect(r.total_lines).toBe(4);
    expect(r.returned_lines).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it("preserves original line numbers when offset is set", () => {
    const r = formatForRead({ content: SAMPLE, mode: "edit", offset: 3 });
    expect(r.content).toBe("3\tgamma\n4\tdelta\n");
    expect(r.returned_lines).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("truncated=true when limit cuts the tail", () => {
    const r = formatForRead({ content: SAMPLE, mode: "edit", limit: 2 });
    expect(r.content).toBe("1\talpha\n2\tbeta\n");
    expect(r.returned_lines).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("offset + limit combined", () => {
    const r = formatForRead({
      content: SAMPLE,
      mode: "edit",
      offset: 2,
      limit: 2,
    });
    expect(r.content).toBe("2\tbeta\n3\tgamma\n");
    expect(r.truncated).toBe(true);
  });

  it("offset past EOF returns empty content", () => {
    const r = formatForRead({ content: SAMPLE, mode: "edit", offset: 99 });
    expect(r.content).toBe("");
    expect(r.returned_lines).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("empty file produces empty edit output", () => {
    const r = formatForRead({ content: "", mode: "edit" });
    expect(r.content).toBe("");
    expect(r.total_lines).toBe(0);
    expect(r.returned_lines).toBe(0);
  });
});

describe("formatForRead — info_compact mode", () => {
  it("strips trailing whitespace on each line", () => {
    const r = formatForRead({
      content: "foo   \nbar\t\nbaz  \t  \n",
      mode: "info_compact",
    });
    expect(r.content).toBe("foo\nbar\nbaz\n");
  });

  it("collapses runs of 2+ blank lines to a single blank line", () => {
    const r = formatForRead({
      content: "alpha\n\n\n\nbeta\n\n\ngamma\n",
      mode: "info_compact",
    });
    expect(r.content).toBe("alpha\n\nbeta\n\ngamma\n");
  });

  it("preserves leading indent when no path is given (safe default)", () => {
    const r = formatForRead({
      content: "def foo():\n    return 1\n    return 2\n",
      mode: "info_compact",
    });
    expect(r.content).toBe("def foo():\n    return 1\n    return 2\n");
  });

  it("preserves leading indent on .py files (indent-sensitive)", () => {
    const r = formatForRead({
      content: "def foo():\n    return 1\n",
      mode: "info_compact",
      path: "/x/script.py",
    });
    expect(r.content).toBe("def foo():\n    return 1\n");
  });

  it("preserves leading indent on .yaml files", () => {
    const r = formatForRead({
      content: "root:\n  nested: 1\n  other: 2\n",
      mode: "info_compact",
      path: "/x/config.yaml",
    });
    expect(r.content).toBe("root:\n  nested: 1\n  other: 2\n");
  });

  it("preserves leading indent on Makefile (basename match)", () => {
    const r = formatForRead({
      content: "build:\n\techo hi\n",
      mode: "info_compact",
      path: "/x/Makefile",
    });
    expect(r.content).toBe("build:\n\techo hi\n");
  });

  it("strips leading indent on .ts files (not indent-sensitive)", () => {
    const r = formatForRead({
      content: "function foo() {\n    return 1;\n}\n",
      mode: "info_compact",
      path: "/x/a.ts",
    });
    expect(r.content).toBe("function foo() {\nreturn 1;\n}\n");
  });

  it("collapses multi-whitespace runs inside a line", () => {
    const r = formatForRead({
      content: "foo(a,    b,\t\tc)\n",
      mode: "info_compact",
    });
    expect(r.content).toBe("foo(a, b, c)\n");
  });

  it("collapses multi-whitespace but preserves leading indent on .py", () => {
    const r = formatForRead({
      content: "    foo(a,    b)\n",
      mode: "info_compact",
      path: "/x/a.py",
    });
    expect(r.content).toBe("    foo(a, b)\n");
  });

  it("minifies valid JSON on .json files", () => {
    const r = formatForRead({
      content: "{\n  \"a\": 1,\n  \"b\": [2, 3]\n}\n",
      mode: "info_compact",
      path: "/x/data.json",
    });
    expect(r.content).toBe('{"a":1,"b":[2,3]}');
    expect(r.returned_lines).toBe(1);
  });

  it("falls back to line-based compact on invalid JSON", () => {
    const r = formatForRead({
      content: "{ not valid json   \n",
      mode: "info_compact",
      path: "/x/broken.json",
    });
    expect(r.content).toBe("{ not valid json\n");
  });

  it("preserves single blank lines between content", () => {
    const r = formatForRead({
      content: "a\n\nb\n",
      mode: "info_compact",
    });
    expect(r.content).toBe("a\n\nb\n");
  });

  it("preserves CRLF endings", () => {
    const r = formatForRead({
      content: "a   \r\nb\r\n\r\n\r\nc\r\n",
      mode: "info_compact",
    });
    expect(r.content).toBe("a\r\nb\r\n\r\nc\r\n");
  });

  it("returned_lines reflects post-compact line count", () => {
    const r = formatForRead({
      content: "a\n\n\n\nb\n",
      mode: "info_compact",
    });
    expect(r.total_lines).toBe(5); // source has 5 lines (a, 3 blanks, b)
    expect(r.returned_lines).toBe(3); // compacted: a, 1 blank, b
  });

  it("slices source by offset/limit BEFORE compacting", () => {
    // Source lines 1-7: "a", "b", "", "", "", "c", "d"
    // offset=2, limit=4 -> slice lines 2-5: "b", "", "", ""
    // After compact: "b", "" (one blank preserved, trailing blank collapsed)
    const r = formatForRead({
      content: "a\nb\n\n\n\nc\nd\n",
      mode: "info_compact",
      offset: 2,
      limit: 4,
    });
    expect(r.content).toBe("b\n\n");
    expect(r.total_lines).toBe(7);
    expect(r.truncated).toBe(true);
  });

  it("collapses trailing blank-line runs that touch EOF", () => {
    const r = formatForRead({
      content: "x\n\n\n\n",
      mode: "info_compact",
    });
    expect(r.content).toBe("x\n\n");
  });
});

describe("formatForRead — info_verbatim mode", () => {
  it("returns content byte-exact when reading full file", () => {
    const r = formatForRead({ content: SAMPLE, mode: "info_verbatim" });
    expect(r.content).toBe(SAMPLE);
    expect(r.truncated).toBe(false);
  });

  it("preserves CRLF endings byte-exactly", () => {
    const input = "a\r\nb\r\nc\r\n";
    const r = formatForRead({ content: input, mode: "info_verbatim" });
    expect(r.content).toBe(input);
  });

  it("does not add line numbers", () => {
    const r = formatForRead({ content: SAMPLE, mode: "info_verbatim", limit: 2 });
    expect(r.content).toBe("alpha\nbeta\n");
    expect(r.truncated).toBe(true);
  });

  it("file without trailing newline is preserved", () => {
    const r = formatForRead({ content: "a\nb", mode: "info_verbatim" });
    expect(r.content).toBe("a\nb");
  });
});
