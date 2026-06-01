import { describe, expect, it } from "vitest";
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
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/a.ts': 0/1 ops successful -->\n<!-- op 1 (replace); error: try anchor below; possible verbatim anchor: lines 40-44 -->\nbeta\ngamma\nDELTA-changed`
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
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/a.ts': 0/1 ops successful -->\n<!-- op 0 (replace); error: widen anchor; matches at lines 3, 17, 42 -->`
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

  it("skipped ops: compact range after triggering error", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "partial",
          ops: [
            { index: 0, status: "error", type: "replace", reason: "not_found", hint: { next_action: "'foo' not found in file" } },
            { index: 1, status: "skipped" },
            { index: 2, status: "skipped" },
            { index: 3, status: "skipped" },
          ],
          totalOps: 4,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- Edit: 1 file, 0/4 ops successful -->\n\n<!-- '/a.ts': 0/4 ops successful -->\n<!-- op 0 (replace); error: 'foo' not found in file -->\n<!-- ops 1 to 3; skipped -->`,
    );
  });
});
