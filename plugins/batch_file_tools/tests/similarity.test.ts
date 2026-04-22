import { describe, expect, it } from "vitest";
import {
  buildNearestAnchor,
  findNearestLine,
  levenshtein,
} from "../src/lib/similarity.js";

describe("levenshtein", () => {
  it("identical strings -> 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("empty vs non-empty -> length", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("classic example kitten/sitting = 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("single substitution", () => {
    expect(levenshtein("cat", "cut")).toBe(1);
  });
});

describe("findNearestLine", () => {
  it("finds a near-miss by a single character", () => {
    const content = "alpha\nbeta\ngamma()\ndelta\n";
    // needle is 'gama()' — missing one char of 'gamma()'
    expect(findNearestLine(content, "gama()")).toBe(3);
  });

  it("returns undefined when best match is below similarity threshold", () => {
    const content = "foo\nbar\nbaz\n";
    expect(findNearestLine(content, "completely_different_1234567890")).toBeUndefined();
  });

  it("uses first non-empty line as probe for multi-line needles", () => {
    const content = "line_a\nTARGETED_ANCHOR\nline_c\n";
    // First line of needle is 'TARGETED_ANCHORS' (typo'd — extra 's')
    expect(findNearestLine(content, "TARGETED_ANCHORS\nsomething")).toBe(2);
  });

  it("returns undefined for empty/whitespace needle", () => {
    expect(findNearestLine("a\nb\n", "")).toBeUndefined();
    expect(findNearestLine("a\nb\n", "   \n\t")).toBeUndefined();
  });

  it("skips files above the size cap", () => {
    const bigContent = Array.from({ length: 6000 }, (_, i) => `line_${i}`).join("\n");
    expect(findNearestLine(bigContent, "line_42")).toBeUndefined();
  });

  it("identical match scores similarity 1 and is returned", () => {
    const content = "one\ntwo\nthree\n";
    expect(findNearestLine(content, "two")).toBe(2);
  });
});

describe("buildNearestAnchor", () => {
  it("returns a window bounded by filled lines above and below", () => {
    const content = "alpha\n\nbeta\n\ngamma\n";
    const anchor = buildNearestAnchor(content, 3); // center on 'beta'
    expect(anchor).toBeDefined();
    expect(anchor!.startLine).toBe(1);
    expect(anchor!.endLine).toBe(5);
    expect(anchor!.content).toBe("alpha\n\nbeta\n\ngamma\n");
  });

  it("skips whitespace-only lines when walking outward", () => {
    const content = "real_top\n   \n\t\nTARGET\n \n  \nreal_bot\n";
    const anchor = buildNearestAnchor(content, 4);
    expect(anchor).toBeDefined();
    expect(anchor!.startLine).toBe(1);
    expect(anchor!.endLine).toBe(7);
    expect(anchor!.content).toBe(content);
  });

  it("near top of file: startLine falls back to nearest line itself", () => {
    const content = "first\nsecond\nthird\n";
    const anchor = buildNearestAnchor(content, 1);
    expect(anchor!.startLine).toBe(1);
    expect(anchor!.endLine).toBe(2);
    expect(anchor!.content).toBe("first\nsecond\n");
  });

  it("near bottom of file: endLine falls back to nearest line itself", () => {
    const content = "first\nsecond\nthird\n";
    const anchor = buildNearestAnchor(content, 3);
    expect(anchor!.startLine).toBe(2);
    expect(anchor!.endLine).toBe(3);
    expect(anchor!.content).toBe("second\nthird\n");
  });

  it("preserves CRLF endings byte-exactly", () => {
    const content = "a\r\nb\r\nc\r\n";
    const anchor = buildNearestAnchor(content, 2);
    expect(anchor!.content).toBe("a\r\nb\r\nc\r\n");
  });

  it("widens once when the minimal window is not unique", () => {
    // 'dup' repeats; minimal window 'dup\nalpha\ndup' is not unique —
    // needs widening to include the distinguishing lines.
    const content = "HEAD\ndup\nalpha\ndup\nalpha\ndup\nTAIL\n";
    const anchor = buildNearestAnchor(content, 3); // center on 'alpha' at line 3
    expect(anchor).toBeDefined();
    // After widening, the window should uniquely locate this alpha.
    const text = anchor!.content;
    expect(content.indexOf(text)).toBeGreaterThanOrEqual(0);
    expect(content.indexOf(text, content.indexOf(text) + 1)).toBe(-1);
  });

  it("returns undefined when even the widened window is not unique", () => {
    // Fully repeating pattern — no unique window possible.
    const content = "x\ny\n".repeat(10);
    const anchor = buildNearestAnchor(content, 5);
    expect(anchor).toBeUndefined();
  });

  it("returns undefined for out-of-range center line", () => {
    expect(buildNearestAnchor("a\nb\n", 0)).toBeUndefined();
    expect(buildNearestAnchor("a\nb\n", 99)).toBeUndefined();
  });
});
