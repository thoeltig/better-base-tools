import { describe, expect, it } from "vitest";
import { findNearestLine, levenshtein } from "../src/lib/similarity.js";

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
