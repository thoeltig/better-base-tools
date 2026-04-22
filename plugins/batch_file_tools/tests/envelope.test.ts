import { describe, expect, it } from "vitest";
import { formatEditContent, formatReadContent } from "../src/lib/envelope.js";

describe("formatReadContent", () => {
  it("emits one TextContent per file, meta-header then raw content", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "info_compact",
          lines: 3,
          returned_lines: 3,
          truncated: false,
          content: "line1\nline2\nline3\n",
        },
        {
          path: "/b.txt",
          mode_applied: "edit",
          lines: 1,
          returned_lines: 1,
          truncated: false,
          content: "1\tonly\n",
        },
      ],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe(
      `<!-- Read 3 lines in file '/a.txt' as 'info_compact' -->\nline1\nline2\nline3\n`,
    );
    expect(blocks[1]!.text).toBe(
      `<!-- Read 1 line in file '/b.txt' as 'edit' -->\n1\tonly\n`,
    );
  });

  it("sliced read: meta carries returned_lines", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "edit",
          lines: 10,
          returned_lines: 2,
          truncated: true,
          content: "3\tc\n4\td\n",
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- Read 2 of 10 lines in file '/a.txt' as 'edit' -->\n3\tc\n4\td\n`,
    );
  });

  it("error result: comment hint only", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/missing.txt",
          mode_applied: "edit",
          lines: 0,
          returned_lines: 0,
          truncated: false,
          error: { reason: "not_found", message: "no such file" },
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- 'not_found' error reading file '/missing.txt' as 'edit': no such file -->\n`,
    );
  });

  it("newlines in content are NOT json-escaped (token win over wrapped JSON)", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/a.txt",
          mode_applied: "info_verbatim",
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
  it("minimal happy path: single-line comment, no body", () => {
    const blocks = formatEditContent({
      results: [{ path: "/a.ts", status: "ok", ops: [] }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- Edited '/a.ts' -->`);
  });

  it("summary mode: multi-line comment lists every op", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "ok",
          ops: [
            { index: 0, status: "ok", type: "append", summary: "appended 1 line" },
            {
              index: 1,
              status: "ok",
              type: "replace",
              summary: "replaced 1 occurrence at line 4",
            },
          ],
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!--\nEdited '/a.ts'\n- op 0 (append): appended 1 line\n- op 1 (replace): replaced 1 occurrence at line 4\n-->`,
    );
  });

  it("partial with nearest_anchor: failed op line in header, anchor raw in body", () => {
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
    expect(blocks[0]!.text).toBe(
      `<!--\nEdited '/a.ts'\n- op 1 (replace): not_found — try anchor below\n-->\n` +
        `<!-- op 1 nearest_anchor, lines 40-44 -->\nbeta\ngamma\nDELTA-changed`,
    );
  });

  it("ambiguous: match_lines inlined in header, no body", () => {
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
    expect(blocks[0]!.text).toBe(
      `<!--\nEdited '/a.ts'\n- op 0 (replace): ambiguous — widen anchor (matches at lines 3, 17, 42)\n-->`,
    );
  });

  it("file-level diff: single-line comment, diff unescaped below", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "ok",
          ops: [],
          diff: "@@ -1,3 +1,3 @@\n a\n-b\n+BEE\n c\n",
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- Edited '/a.ts' -->\n@@ -1,3 +1,3 @@\n a\n-b\n+BEE\n c`,
    );
    expect(blocks[0]!.text.includes("\\n")).toBe(false);
  });

  it("op-level diff: labeled per-op diff in body", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.ts",
          status: "ok",
          ops: [
            {
              index: 0,
              status: "ok",
              type: "append",
              diff: "@@ -2,0 +3,1 @@\n+c\n",
            },
          ],
        },
      ],
    });
    expect(blocks[0]!.text).toBe(
      `<!--\nEdited '/a.ts'\n- op 0 (append)\n-->\n<!-- op 0 diff -->\n@@ -2,0 +3,1 @@\n+c`,
    );
  });

  it("file-level error: reason + message surfaced in header", () => {
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
    expect(blocks[0]!.text).toBe(
      `<!--\n'io_error' error editing file '/missing.ts': not absolute\n- op 0 (replace): io_error — not absolute\n-->`,
    );
  });
});
