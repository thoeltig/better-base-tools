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
          mode_applied: "verbatim_numbered",
          lines: 1,
          returned_lines: 1,
          truncated: false,
          content: "1\tonly\n",
        },
      ],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(
      `<!-- Read 3 lines in file '/a.txt' as 'compact' -->\nline1\nline2\nline3\n`,
    );
    expect(blocks[1]!.text).toBe(
      `<!-- Read 1 line in file '/b.txt' as 'verbatim_numbered' -->\n1\tonly\n`,
    );
  });

  it("sliced read: meta carries returned_lines", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "verbatim_numbered",
          lines: 10,
          returned_lines: 2,
          truncated: true,
          content: "3\tc\n4\td\n",
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- Read 2 of 10 lines in file '/a.txt' as 'verbatim_numbered' -->\n3\tc\n4\td\n`,
    );
  });

  it("error result: comment hint only", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/missing.txt",
          mode_applied: "verbatim_numbered",
          lines: 0,
          returned_lines: 0,
          truncated: false,
          content: '',
          error: { reason: "not_found", message: "no such file" },
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- 'not_found' error reading file '/missing.txt' as 'verbatim_numbered': no such file -->\n`,
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

describe("formatEditContent", () => {
  it("single file OK: compact one-liner with path", () => {
    const blocks = formatEditContent({
      results: [{ path: "/a.ts", status: "ok", ops: [] }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- batch_edit OK — /a.ts -->`);
  });

  it("dryRun OK: prefixed with DRY RUN", () => {
    const blocks = formatEditContent({ results: [{ path: "/a.ts", status: "ok", ops: [] }] }, [], false, true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- DRY RUN: batch_edit OK — /a.ts -->`);
  });

  it("multi-file all OK: compact one-liner with count", () => {
    const blocks = formatEditContent({
      results: [
        { path: "/a.ts", status: "ok", ops: [] },
        { path: "/b.ts", status: "ok", ops: [] },
        { path: "/c.ts", status: "ok", ops: [] },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- batch_edit OK — 3 files -->`);
  });

  it("successful ops with verbose summaries collapse to OK line", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "ok",
          ops: [
            { index: 0, status: "ok", summary: "appended 1 line" },
            { index: 1, status: "ok", summary: "replaced 1 occurrence at line 4" },
          ],
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- batch_edit OK — /a.ts -->`);
  });

  it("partial with nearest_anchor: summary block + separate anchor block", () => {
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
        },
      ],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(
      `<!--\nbatch_edit — 1 error\n\n/a.ts (partial):\n  op 1 (replace): not_found — try anchor below\n-->`,
    );
    expect(blocks[1]!.text).toBe(
      `<!-- op 1 nearest_anchor: /a.ts lines 40-44 -->\nbeta\ngamma\nDELTA-changed`,
    );
  });

  it("ambiguous: match_lines in summary block, no anchor block", () => {
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
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!--\nbatch_edit — 1 error\n\n/a.ts (error):\n  op 0 (replace): ambiguous — widen anchor (matches at lines 3, 17, 42)\n-->`,
    );
  });

  it("file-level error: reason + message in summary block", () => {
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
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!--\nbatch_edit — 1 error\n\n/missing.ts — io_error: not absolute\n  op 0 (replace): io_error — not absolute\n-->`,
    );
  });
});
