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
    expect(blocks[0]!.text).toBe('{"path":"/a.txt","lines":3}\nline1\nline2\nline3\n');
    expect(blocks[1]!.text).toBe('{"path":"/b.txt","lines":1}\n1\tonly\n');
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
      '{"path":"/a.txt","lines":10,"returned_lines":2}\n3\tc\n4\td\n',
    );
  });

  it("error result: meta-only JSON block", () => {
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
      '{"path":"/missing.txt","error":{"reason":"not_found","message":"no such file"}}',
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
  it("no diff: single JSON line per file", () => {
    const blocks = formatEditContent({
      results: [
        { path: "/a.txt", status: "ok", ops: [] },
        {
          path: "/b.txt",
          status: "partial",
          ops: [
            {
              index: 1,
              status: "error",
              type: "replace",
              reason: "not_found",
              hint: { next_action: "..." },
            },
          ],
        },
      ],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe('{"path":"/a.txt","status":"ok","ops":[]}');
    const second = JSON.parse(blocks[1]!.text) as { status: string; ops: unknown[] };
    expect(second.status).toBe("partial");
    expect(second.ops).toHaveLength(1);
  });

  it("file-level diff: meta JSON on line 1, raw diff unescaped below", () => {
    const blocks = formatEditContent({
      results: [
        {
          path: "/a.txt",
          status: "ok",
          ops: [],
          diff: "--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    });
    const text = blocks[0]!.text;
    const [header, ...rest] = text.split("\n");
    const parsed = JSON.parse(header!) as Record<string, unknown>;
    expect(parsed["path"]).toBe("/a.txt");
    expect(parsed).not.toHaveProperty("diff");
    expect(rest.join("\n")).toBe("--- a\n+++ a\n@@ -1 +1 @@\n-old\n+new\n");
  });
});
