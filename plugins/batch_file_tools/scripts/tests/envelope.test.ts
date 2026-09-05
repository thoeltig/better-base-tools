import { describe, it } from "node:test";
import { expect } from "./helpers/expect.js";
import { formatEditContent, formatReadContent } from "../src/lib/envelope.js";

describe("formatReadContent", () => {
  it("emits one TextContent per file, meta-header then raw content", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "compact",
          lines: 3,
          returned_lines: 3,
          truncated: false,
          content: "line1\nline2\nline3\n",
        },
        {
          path: "/b.txt",
          mode_applied: "verbatim",
          lines: 1,
          returned_lines: 1,
          truncated: false,
          content: "1\tonly\n",
        },
      ],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(
      `<!-- Read line 1 to 3 of file '/a.txt' as 'compact' (3 lines total) -->\nline1\nline2\nline3\n`,
    );
    expect(blocks[1]!.text).toBe(
      `<!-- Read line 1 of file '/b.txt' as 'verbatim' (1 line total) -->\n1\tonly\n`,
    );
  });

  it("sliced read: meta carries returned_lines", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "verbatim",
          lines: 10,
          returned_lines: 2,
          start_line: 3,
          truncated: true,
          content: "3\tc\n4\td\n",
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- Read line 3 to 4 of file '/a.txt' as 'verbatim' (2 of 10 lines total) -->\n3\tc\n4\td\n`,
    );
  });

  it("error result: comment hint only", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/missing.txt",
          mode_applied: "verbatim",
          lines: 0,
          returned_lines: 0,
          truncated: false,
          content: '',
          error: { reason: "not_found", message: "no such file" },
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- 'not_found' error reading file '/missing.txt' as 'verbatim': no such file -->\n`,
    );
  });

  it("newlines in content are NOT json-escaped (token win over wrapped JSON)", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "verbatim",
          lines: 2,
          returned_lines: 2,
          truncated: false,
          content: "x\ny\n",
        },
      ],
    });
    expect(blocks[0]!.text.includes("\\n")).toBe(false);
    expect(blocks[0]!.text.endsWith("x\ny\n")).toBe(true);
  });
});

describe("formatReadContent — new search output formats", () => {
  it("count=0: Found header + inline lineNum\\tcontent per match", () => {
    const blocks = formatReadContent({
      results: [{
        path: "/src/types.ts",
        mode_applied: "compact",
        lines: 262,
        returned_lines: 2,
        truncated: false,
        content: "170\texport const EditInput\n176\texport type EditInput",
        match_count: 2,
      }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Found 2 match(es) in 262 lines of '/src/types.ts' as 'compact' -->\n170\texport const EditInput\n176\texport type EditInput`
    );
  });

  it("count>0: Found header + <!-- Line M to N, match at line K --> blocks in content", () => {
    const blocks = formatReadContent({
      results: [{
        path: "/src/readme.md",
        mode_applied: "verbatim",
        lines: 122,
        returned_lines: 5,
        truncated: false,
        content: "<!-- Line 70 to 74, match at line 72 -->\nline70\nTARGET\nline74",
        match_count: 1,
      }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Found 1 match(es) in 122 lines of '/src/readme.md' as 'verbatim' -->\n<!-- Line 70 to 74, match at line 72 -->\nline70\nTARGET\nline74`
    );
  });

  it("all zero-match results consolidated into one block", () => {
    const blocks = formatReadContent({
      results: [
        { path: "/a.ts", mode_applied: "compact", lines: 10, returned_lines: 0, truncated: false, content: "", match_count: 0 },
        { path: "/b.ts", mode_applied: "compact", lines: 20, returned_lines: 0, truncated: false, content: "", match_count: 0 },
        { path: "/c.ts", mode_applied: "compact", lines: 5,  returned_lines: 0, truncated: false, content: "", match_count: 0 },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- No match(es) found -->\n'/a.ts'\n'/b.ts'\n'/c.ts'`);
  });

  it("mixed: matched files get individual blocks, no-match files get one consolidated block", () => {
    const blocks = formatReadContent({
      results: [
        { path: "/a.ts", mode_applied: "compact", lines: 100, returned_lines: 2, truncated: false, content: "7\timport { foo }\n91\texport const bar", match_count: 2 },
        { path: "/b.ts", mode_applied: "compact", lines: 50,  returned_lines: 0, truncated: false, content: "", match_count: 0 },
        { path: "/c.ts", mode_applied: "compact", lines: 30,  returned_lines: 0, truncated: false, content: "", match_count: 0 },
      ],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(
      `<!-- Found 2 match(es) in 100 lines of '/a.ts' as 'compact' -->\n7\timport { foo }\n91\texport const bar`
    );
    expect(blocks[1]!.text).toBe(`<!-- No match(es) found -->\n'/b.ts'\n'/c.ts'`);
  });

  it("sliced read: header encodes start_line and end_line from result", () => {
    const blocks = formatReadContent({
      results: [{
        path: "/src/types.ts",
        mode_applied: "verbatim",
        lines: 262,
        returned_lines: 12,
        start_line: 168,
        truncated: false,
        content: "export type EditFile = z.infer<typeof EditFile>;",
      }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Read line 168 to 179 of file '/src/types.ts' as 'verbatim' (12 of 262 lines total) -->\nexport type EditFile = z.infer<typeof EditFile>;`
    );
  });

  it("full-file read: header shows line 1 to N with total only", () => {
    const blocks = formatReadContent({
      results: [{
        path: "/src/index.ts",
        mode_applied: "compact",
        lines: 50,
        returned_lines: 50,
        start_line: 1,
        truncated: false,
        content: "export default function main() {}",
      }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Read line 1 to 50 of file '/src/index.ts' as 'compact' (50 lines total) -->\nexport default function main() {}`
    );
  });
});

describe("formatEditContent", () => {
  it("single file OK: overview with file and op count", () => {
    const blocks = formatEditContent({
      results: [{ path: "/a.ts", status: "ok", ops: [], totalOps: 0 }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- Edit: 1 file, 0 ops successful -->`);
  });

  it("dryRun OK: prefixed with DRY RUN", () => {
    const blocks = formatEditContent({ results: [{ path: "/a.ts", status: "ok", ops: [], totalOps: 0 }] }, [], false, true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- DRY RUN: Edit: 1 file, 0 ops successful -->`);
  });

  it("multi-file all OK: compact one-liner with count", () => {
    const blocks = formatEditContent({
      results: [
        { path: "/a.ts", status: "ok", ops: [], totalOps: 0 },
        { path: "/b.ts", status: "ok", ops: [], totalOps: 0 },
        { path: "/c.ts", status: "ok", ops: [], totalOps: 0 },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- Edit: 3 files, 0 ops successful -->`);
  });

  it("successful ops: overview shows op count", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "ok",
          ops: [],
          totalOps: 2,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- Edit: 1 file, 2 ops successful -->`);
  });

  it("partial with nearest_anchor: overview + file block with inline anchor", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "partial",
          ops: [
            {
              index: 1,
              status: "error",
              type: "replace",
              target: 'old: "beta\\ngamma\\nDELTA"',
              reason: "not_found",
              hint: {
                next_action: "try anchor below",
                nearest_anchor: {
                  start_line: 40,
                  end_line: 44,
                  content: "beta\ngamma\nDELTA-changed\n",
                },
              },
            },
          ],
          totalOps: 1,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/a.ts': 0/1 ops successful -->\n<!-- op (replace) old: "beta\\ngamma\\nDELTA"; error: try anchor below; possible verbatim anchor: lines 40-44 -->\nbeta\ngamma\nDELTA-changed`
    );
  });

  it("ambiguous: overview + file block with match lines", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "error",
          ops: [
            {
              index: 0,
              status: "error",
              type: "replace",
              target: 'old: "### Fixed"',
              reason: "ambiguous",
              hint: {
                next_action: "widen anchor",
                match_lines: [3, 17, 42],
              },
            },
          ],
          totalOps: 1,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/a.ts': 0/1 ops successful -->\n<!-- op (replace) old: "### Fixed"; error: widen anchor; matches at lines 3, 17, 42 -->`
    );
  });

  it("file-level error: overview + file block with error reason", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/missing.ts",
          status: "error",
          error: { reason: "io_error", message: "not absolute" },
          ops: [
            {
              index: 0,
              status: "error",
              type: "replace",
              reason: "io_error",
              hint: { next_action: "not absolute" },
            },
          ],
          totalOps: 1,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/missing.ts': 0/1 ops successful -->\n<!-- file error: io_error: not absolute -->`
    );
  });

  it("skipped ops are named individually after the triggering error", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "partial",
          ops: [
            { index: 0, status: "error", type: "replace", target: 'old: "foo"', reason: "not_found", hint: { next_action: "'foo' not found in file" } },
            { index: 1, status: "skipped", type: "write", target: "mode: append" },
            { index: 2, status: "skipped", type: "replace_range", target: "lines 10-12" },
            { index: 3, status: "skipped", type: "replace", target: 'old: "bar"' },
          ],
          totalOps: 4,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Edit: 1 file, 0/4 ops successful -->\n\n<!-- '/a.ts': 0/4 ops successful -->\n<!-- op (replace) old: "foo"; error: 'foo' not found in file -->\n<!-- op (write) mode: append; skipped -->\n<!-- op (replace_range) lines 10-12; skipped -->\n<!-- op (replace) old: "bar"; skipped -->`,
    );
  });
});

describe("formatReadContent — output budget (maxChars)", () => {
  const makeLines = (n: number) =>
    Array.from({ length: n }, (_, i) => `L${String(i + 1).padStart(3, "0")}X-${"z".repeat(20)}`);

  it("maxChars=0 disables truncation (full content, no marker)", () => {
    const content = makeLines(50).join("\n") + "\n";
    const blocks = formatReadContent(
      { results: [{ path: "/big.txt", mode_applied: "compact", lines: 50, returned_lines: 50, truncated: false, content }] },
      [],
      false,
      0,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text.includes("L050X")).toBe(true);
    expect(blocks[0]!.text.includes("Truncated at line")).toBe(false);
  });

  it("mid-file truncation: header range shrinks and inline marker gives a re-read anchor", () => {
    const content = makeLines(100).join("\n") + "\n";
    const blocks = formatReadContent(
      { results: [{ path: "/big.txt", mode_applied: "compact", lines: 100, returned_lines: 100, truncated: false, content }] },
      [],
      false,
      800,
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    const m = text.match(/Read line 1 to (\d+) of file '\/big\.txt' as 'compact' \((\d+) of 100 lines total\)/);
    expect(m).not.toBe(null);
    const endLine = Number(m![1]);
    expect(Number(m![2])).toBe(endLine);
    expect(endLine).toBeLessThanOrEqual(99);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text.includes(`L${String(endLine).padStart(3, "0")}X`)).toBe(true);
    expect(text.includes(`L${String(endLine + 1).padStart(3, "0")}X`)).toBe(false);
    expect(text.includes(`Truncated at line ${endLine} of 100`)).toBe(true);
    expect(text.includes(`re-read from line ${endLine + 1}`)).toBe(true);
  });

  it("truncation stops later files; they are listed in a trailing omitted marker", () => {
    const contentA = makeLines(100).join("\n") + "\n";
    const blocks = formatReadContent(
      {
        results: [
          { path: "/a.txt", mode_applied: "compact", lines: 100, returned_lines: 100, truncated: false, content: contentA },
          { path: "/b.txt", mode_applied: "compact", lines: 3, returned_lines: 3, truncated: false, content: "b1\nb2\nb3\n" },
          { path: "/c.txt", mode_applied: "compact", lines: 2, returned_lines: 2, truncated: false, content: "c1\nc2\n" },
        ],
      },
      [],
      false,
      600,
    );
    const joined = blocks.map(b => b.text).join("\n");
    expect(joined.includes("Truncated at line")).toBe(true);
    const last = blocks[blocks.length - 1]!.text;
    expect(last.includes("Max output reached — could not return")).toBe(true);
    expect(last.includes("/b.txt")).toBe(true);
    expect(last.includes("/c.txt")).toBe(true);
    expect(joined.includes("b1")).toBe(false);
    expect(joined.includes("c1")).toBe(false);
  });

  it("non-truncatable first result (single long line) is emitted whole to guarantee progress", () => {
    const content = "x".repeat(500);
    const blocks = formatReadContent(
      { results: [{ path: "/x.ts", mode_applied: "verbatim", lines: 1, returned_lines: 1, truncated: false, content }] },
      [],
      false,
      10,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text.includes(content)).toBe(true);
    expect(blocks[0]!.text.includes("Truncated")).toBe(false);
  });

  it("search (count=0) truncates at a match-line boundary, keeping the Found header", () => {
    const content = Array.from({ length: 40 }, (_, i) => `${(i + 1) * 3}\tmatchline-${String(i + 1).padStart(2, "0")}`).join("\n");
    const blocks = formatReadContent(
      { results: [{ path: "/s.ts", mode_applied: "compact", lines: 400, returned_lines: 40, truncated: false, content, match_count: 40 }] },
      [],
      false,
      500,
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    expect(text.includes("Found 40 match(es)")).toBe(true);
    expect(text.includes("matchline-01")).toBe(true);
    expect(text.includes("matchline-40")).toBe(false);
    expect(text.includes("of 40 match block")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it("search (count>0) truncates at a context-block boundary", () => {
    const mkBlock = (n: number) =>
      `<!-- Line ${n} to ${n + 2}, match at line ${n + 1} -->\nctx-${String(n).padStart(3, "0")}-a\nctx-${String(n).padStart(3, "0")}-b\nctx-${String(n).padStart(3, "0")}-c`;
    const content = [10, 40, 70, 100, 130].map(mkBlock).join("\n");
    const blocks = formatReadContent(
      { results: [{ path: "/s.ts", mode_applied: "verbatim", lines: 200, returned_lines: 15, truncated: false, content, match_count: 5 }] },
      [],
      false,
      260,
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    expect(text.includes("Found 5 match(es)")).toBe(true);
    expect(text.includes("ctx-010-a")).toBe(true);
    expect(text.includes("ctx-130-a")).toBe(false);
    expect(text.includes("match block")).toBe(true);
  });
});
