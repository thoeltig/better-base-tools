import { describe, it } from "node:test";
import { expect } from "./helpers/expect.js";
import { joinLines, splitLines } from "../src/lib/lines.js";

describe("splitLines", () => {
  it("empty content has zero lines", () => {
    const r = splitLines("");
    expect(r.lines).toEqual([]);
    expect(r.endings).toEqual([]);
  });

  it("single empty line = one LF", () => {
    const r = splitLines("\n");
    expect(r.lines).toEqual([""]);
    expect(r.endings).toEqual(["\n"]);
  });

  it("file with trailing newline — last line counted once", () => {
    const r = splitLines("a\nb\n");
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.endings).toEqual(["\n", "\n"]);
  });

  it("file without trailing newline", () => {
    const r = splitLines("a\nb");
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.endings).toEqual(["\n", ""]);
  });

  it("preserves CRLF alongside LF", () => {
    const r = splitLines("a\r\nb\nc\r\n");
    expect(r.lines).toEqual(["a", "b", "c"]);
    expect(r.endings).toEqual(["\r\n", "\n", "\r\n"]);
  });

  it("does not mistake a bare \\r for an ending", () => {
    const r = splitLines("a\rb\n");
    expect(r.lines).toEqual(["a\rb"]);
    expect(r.endings).toEqual(["\n"]);
  });
});

describe("joinLines round-trips", () => {
  const cases = [
    "",
    "\n",
    "a\nb\n",
    "a\nb",
    "a\r\nb\r\n",
    "a\r\nb\nc\r\n",
    "a\rb\n",
    "line1\nline2\nline3",
  ];

  for (const input of cases) {
    it(`byte-exact: ${JSON.stringify(input)}`, () => {
      const r = splitLines(input);
      expect(joinLines(r.lines, r.endings)).toBe(input);
    });
  }
});

describe("countLines", () => {
  it("counts all lines regardless of trailing newline", () => {
    expect(splitLines("a\nb\n").lines.length).toBe(2);
    expect(splitLines("a\nb").lines.length).toBe(2);
    expect(splitLines("").lines.length).toBe(0);
    expect(splitLines("\n").lines.length).toBe(1);
  });
});
