import { describe, expect, it } from "vitest";
import { formatForRead } from "../src/lib/transforms.js";

const SAMPLE = "alpha\nbeta\ngamma\ndelta\n";


describe("formatForRead — compact mode", () => {
  it("strips trailing whitespace on each line", () => {
    const r = formatForRead({
      content: "foo   \nbar\t\nbaz  \t  \n",
      mode: "compact",
    });
    expect(r.content).toBe("foo\nbar\nbaz\n");
  });

  it("collapses runs of 2+ blank lines to a single blank line", () => {
    const r = formatForRead({
      content: "alpha\n\n\n\nbeta\n\n\ngamma\n",
      mode: "compact",
    });
    expect(r.content).toBe("alpha\n\nbeta\n\ngamma\n");
  });

  it("preserves leading indent when no path is given (safe default)", () => {
    const r = formatForRead({
      content: "def foo():\n    return 1\n    return 2\n",
      mode: "compact",
    });
    expect(r.content).toBe("def foo():\n    return 1\n    return 2\n");
  });

  it("preserves leading indent on .py files (indent-sensitive)", () => {
    const r = formatForRead({
      content: "def foo():\n    return 1\n",
      mode: "compact",
      path: "/x/script.py",
    });
    expect(r.content).toBe("def foo():\n    return 1\n");
  });

  it("preserves leading indent on .yaml files", () => {
    const r = formatForRead({
      content: "root:\n  nested: 1\n  other: 2\n",
      mode: "compact",
      path: "/x/config.yaml",
    });
    expect(r.content).toBe("root:\n  nested: 1\n  other: 2\n");
  });

  it("preserves leading indent on Makefile (basename match)", () => {
    const r = formatForRead({
      content: "build:\n\techo hi\n",
      mode: "compact",
      path: "/x/Makefile",
    });
    expect(r.content).toBe("build:\n\techo hi\n");
  });

  it("collapses .ts file to single line (not indent-sensitive)", () => {
    const r = formatForRead({
      content: "function foo() {\n    return 1;\n}\n",
      mode: "compact",
      path: "/x/a.ts",
    });
    expect(r.content).toBe("function foo() { return 1; }");
    expect(r.returned_lines).toBe(1);
  });

  it("collapses multi-whitespace runs inside a line", () => {
    const r = formatForRead({
      content: "foo(a,    b,\t\tc)\n",
      mode: "compact",
    });
    expect(r.content).toBe("foo(a, b, c)\n");
  });

  it("collapses multi-whitespace but preserves leading indent on .py", () => {
    const r = formatForRead({
      content: "    foo(a,    b)\n",
      mode: "compact",
      path: "/x/a.py",
    });
    expect(r.content).toBe("    foo(a, b)\n");
  });

  it("minifies valid JSON on .json files", () => {
    const r = formatForRead({
      content: "{\n  \"a\": 1,\n  \"b\": [2, 3]\n}\n",
      mode: "compact",
      path: "/x/data.json",
    });
    expect(r.content).toBe('{"a":1,"b":[2,3]}');
    expect(r.returned_lines).toBe(1);
  });

  it("falls back to single-line compact on invalid JSON", () => {
    const r = formatForRead({
      content: "{ not valid json   \n",
      mode: "compact",
      path: "/x/broken.json",
    });
    expect(r.content).toBe("{ not valid json");
    expect(r.returned_lines).toBe(1);
  });

  it("preserves single blank lines between content", () => {
    const r = formatForRead({
      content: "a\n\nb\n",
      mode: "compact",
    });
    expect(r.content).toBe("a\n\nb\n");
  });

  it("preserves CRLF endings", () => {
    const r = formatForRead({
      content: "a   \r\nb\r\n\r\n\r\nc\r\n",
      mode: "compact",
    });
    expect(r.content).toBe("a\r\nb\r\n\r\nc\r\n");
  });

  it("returned_lines reflects post-compact line count", () => {
    const r = formatForRead({
      content: "a\n\n\n\nb\n",
      mode: "compact",
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
      mode: "compact",
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
      mode: "compact",
    });
    expect(r.content).toBe("x\n\n");
  });

  it("non-indent-sensitive: blank lines dropped, tokens joined", () => {
    const r = formatForRead({
      content: "const x = 1;\n\nconst y = 2;\n",
      mode: "compact",
      path: "/x/a.js",
    });
    expect(r.content).toBe("const x = 1; const y = 2;");
    expect(r.returned_lines).toBe(1);
  });

  it("non-indent-sensitive: empty file produces empty string", () => {
    const r = formatForRead({ content: "", mode: "compact", path: "/x/a.ts" });
    expect(r.content).toBe("");
    expect(r.returned_lines).toBe(0);
  });

  it("non-indent-sensitive: all-blank lines produces empty string", () => {
    const r = formatForRead({ content: "\n\n\n", mode: "compact", path: "/x/a.ts" });
    expect(r.content).toBe("");
    expect(r.returned_lines).toBe(0);
  });

  it("non-indent-sensitive: tabs and mixed indent collapsed", () => {
    const r = formatForRead({
      content: "if (x) {\n\treturn 1;\n}\n",
      mode: "compact",
      path: "/x/a.ts",
    });
    expect(r.content).toBe("if (x) { return 1; }");
  });
});

describe("formatForRead — verbatim mode", () => {
  it("returns content byte-exact when reading full file", () => {
    const r = formatForRead({ content: SAMPLE, mode: "verbatim" });
    expect(r.content).toBe(SAMPLE);
    expect(r.truncated).toBe(false);
  });

  it("preserves CRLF endings byte-exactly", () => {
    const input = "a\r\nb\r\nc\r\n";
    const r = formatForRead({ content: input, mode: "verbatim" });
    expect(r.content).toBe(input);
  });

  it("does not add line numbers", () => {
    const r = formatForRead({ content: SAMPLE, mode: "verbatim", limit: 2 });
    expect(r.content).toBe("alpha\nbeta\n");
    expect(r.truncated).toBe(true);
  });

  it("file without trailing newline is preserved", () => {
    const r = formatForRead({ content: "a\nb", mode: "verbatim" });
    expect(r.content).toBe("a\nb");
  });
});

describe("formatForRead — verbatim indent normalization (Phase 4)", () => {
  it("tab-indented: each leading tab → 2 spaces", () => {
    const r = formatForRead({ content: "function foo() {\n\treturn 1;\n}\n", mode: "verbatim" });
    expect(r.content).toBe("function foo() {\n  return 1;\n}\n");
  });

  it("double-tab nesting: each tab level → 2 spaces", () => {
    const r = formatForRead({ content: "class A {\n\tb() {\n\t\treturn 1;\n\t}\n}\n", mode: "verbatim" });
    expect(r.content).toBe("class A {\n  b() {\n    return 1;\n  }\n}\n");
  });

  it("4-space-indented: 4 spaces → 2 spaces per level", () => {
    const r = formatForRead({ content: "function foo() {\n    return 1;\n}\n", mode: "verbatim", path: "/x/a.ts" });
    expect(r.content).toBe("function foo() {\n  return 1;\n}\n");
  });

  it("2-space-indented: unchanged", () => {
    const r = formatForRead({ content: "function foo() {\n  return 1;\n}\n", mode: "verbatim", path: "/x/a.ts" });
    expect(r.content).toBe("function foo() {\n  return 1;\n}\n");
  });

  it("mixed 4/8 space: GCD=4, normalizes to 2 and 4 spaces", () => {
    const r = formatForRead({ content: "a:\n    b:\n        c: 1\n", mode: "verbatim", path: "/x/a.ts" });
    expect(r.content).toBe("a:\n  b:\n    c: 1\n");
  });

  it(".py path: 4-space → 2-space (indent-sensitive but not tab-required)", () => {
    const r = formatForRead({ content: "def foo():\n    return 1\n", mode: "verbatim", path: "/x/a.py" });
    expect(r.content).toBe("def foo():\n  return 1\n");
  });

  it("Makefile path: tabs preserved (tab-required)", () => {
    const r = formatForRead({ content: "build:\n\techo hi\n", mode: "verbatim", path: "/x/Makefile" });
    expect(r.content).toBe("build:\n\techo hi\n");
  });

  it("CRLF file: endings preserved after normalization", () => {
    const r = formatForRead({ content: "function foo() {\r\n\treturn 1;\r\n}\r\n", mode: "verbatim" });
    expect(r.content).toBe("function foo() {\r\n  return 1;\r\n}\r\n");
  });

  it("normalizeFormatting: false returns tabs as-is", () => {
    const r = formatForRead({ content: "function foo() {\n\treturn 1;\n}\n", mode: "verbatim", normalizeFormatting: false });
    expect(r.content).toBe("function foo() {\n\treturn 1;\n}\n");
  });

  it("normalizeFormatting: false returns 4-space as-is", () => {
    const r = formatForRead({ content: "function foo() {\n    return 1;\n}\n", mode: "verbatim", path: "/x/a.ts", normalizeFormatting: false });
    expect(r.content).toBe("function foo() {\n    return 1;\n}\n");
  });

  it("no indentation: normalization is a no-op", () => {
    const r = formatForRead({ content: SAMPLE, mode: "verbatim" });
    expect(r.content).toBe(SAMPLE);
  });
});
