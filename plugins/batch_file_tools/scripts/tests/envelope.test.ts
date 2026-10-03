import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./helpers/expect.js";
import { formatEditContent, formatReadContent } from "../src/lib/envelope.js";
import { formatForRead } from "../src/lib/transforms.js";

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
      `<!-- 3 lines in '/a.txt' as compact -->\nline1\nline2\nline3\n`,
    );
    expect(blocks[1]!.text).toBe(
      `<!-- 1 line in '/b.txt' as verbatim -->\n1\tonly\n`,
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
      `<!-- Line 3 to 4 of 10 lines in '/a.txt' as verbatim -->\n3\tc\n4\td\n`,
    );
  });

  it("single-line slice: header names one line", () => {
    const blocks = formatReadContent({
      results: [{ path: "/a.ts", mode_applied: "compact", lines: 288, returned_lines: 1, start_line: 8, truncated: true, content: "x" }],
    });
    expect(blocks[0]!.text).toBe(`<!-- Line 8 of 288 lines in '/a.ts' as compact -->\nx\n`);
  });

  it("compact slice: header shows the source range, not the collapsed output line count", () => {
    const blocks = formatReadContent({
      results: [{ path: "/a.ts", mode_applied: "compact", lines: 288, returned_lines: 5, start_line: 8, truncated: true, content: "a; b; c;" }],
    });
    expect(blocks[0]!.text).toBe(`<!-- Line 8 to 12 of 288 lines in '/a.ts' as compact -->\na; b; c;\n`);
  });

  it("empty file: zero-line header", () => {
    const blocks = formatReadContent({
      results: [{ path: "/e.ts", mode_applied: "compact", lines: 0, returned_lines: 0, start_line: 1, truncated: false, content: "" }],
    });
    expect(blocks[0]!.text).toBe(`<!-- 0 lines in '/e.ts' as compact -->\n`);
  });

  it("error result: reason and path, no detail when the message is empty", () => {
    const blocks = formatReadContent({
      results: [
        {
          path: "/missing.txt",
          mode_applied: "verbatim",
          lines: 0,
          returned_lines: 0,
          truncated: false,
          content: '',
          error: { reason: "not_found", message: "" },
        },
      ],
    });
    expect(blocks[0]!.text).toBe(`<!-- Error not_found: '/missing.txt' -->\n`);
  });

  it("not_found error shows the absolute path even below cwd", () => {
    const missing = join(process.cwd(), "sub", "missing.txt");
    const blocks = formatReadContent({
      results: [{ path: missing, mode_applied: "verbatim", lines: 0, returned_lines: 0, truncated: false, content: "", error: { reason: "not_found", message: "" } }],
    });
    expect(blocks[0]!.text).toBe(`<!-- Error not_found: '${missing.split(sep).join("/")}' -->\n`);
  });

  it("other errors keep the short path and append the detail", () => {
    const blocks = formatReadContent({
      results: [{ path: join(process.cwd(), "sub", "x.txt"), mode_applied: "verbatim", lines: 0, returned_lines: 0, truncated: false, content: "", error: { reason: "io_error", message: "EBUSY: resource busy" } }],
    });
    expect(blocks[0]!.text).toBe(`<!-- Error io_error: 'sub/x.txt' — EBUSY: resource busy -->\n`);
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

  it("displays paths below cwd relative with forward slashes", () => {
    const blocks = formatReadContent({
      results: [{ path: join(process.cwd(), "sub", "a.txt"), mode_applied: "verbatim", lines: 1, returned_lines: 1, truncated: false, content: "x\n" }],
    });
    expect(blocks[0]!.text).toContain("'sub/a.txt'");
  });

  it("displays paths outside cwd absolute with forward slashes", () => {
    const outside = resolve(process.cwd(), "..", "..", "outside.txt");
    const blocks = formatReadContent({
      results: [{ path: outside, mode_applied: "verbatim", lines: 1, returned_lines: 1, truncated: false, content: "x\n" }],
    });
    expect(blocks[0]!.text).toContain(`'${outside.split(sep).join("/")}'`);
  });

  it("user summary pluralises the error count", () => {
    const blocks = formatReadContent(
      { results: [{ path: "/missing.txt", mode_applied: "verbatim", lines: 0, returned_lines: 0, truncated: false, content: "", error: { reason: "not_found", message: "no such file" } }] },
      [{ path: "/missing.txt", mode: "verbatim" }],
      true,
    );
    expect(blocks[1]!.text).toContain("1 error");
    expect(blocks[1]!.text).not.toContain("error(s)");
  });
});

describe("formatReadContent — new search output formats", () => {
  it("count=0: match header + inline lineNum\\tcontent per match", () => {
    const blocks = formatReadContent({
      results: [{
        path: "/src/types.ts",
        mode_applied: "compact",
        lines: 262,
        returned_lines: 2,
        truncated: false,
        content: "170\texport const EditInput\n176\texport type EditInput",
        match_count: 2,
        search_term: "EditInput",
      }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- 2 matches for 'EditInput' in '/src/types.ts' (262 lines) as compact -->\n170\texport const EditInput\n176\texport type EditInput\n`
    );
  });

  it("count>0: match header names the regex + <!-- Line M to N --> blocks in content", () => {
    const blocks = formatReadContent({
      results: [{
        path: "/src/readme.md",
        mode_applied: "verbatim",
        lines: 122,
        returned_lines: 5,
        truncated: false,
        content: "<!-- Line 70 to 74 -->\nline70\nTARGET\nline74",
        match_count: 1,
        search_regex: "tar.et",
      }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(
      `<!-- 1 match for /tar.et/ in '/src/readme.md' (122 lines) as verbatim -->\n<!-- Line 70 to 74 -->\nline70\nTARGET\nline74\n`
    );
  });

  it("search without matches in any file: one line per search, no file list", () => {
    const blocks = formatReadContent({
      results: [
        { path: "/a.ts", mode_applied: "compact", lines: 10, returned_lines: 0, truncated: false, content: "", match_count: 0, search_term: "zzz" },
        { path: "/b.ts", mode_applied: "compact", lines: 20, returned_lines: 0, truncated: false, content: "", match_count: 0, search_term: "zzz" },
        { path: "/a.ts", mode_applied: "compact", lines: 10, returned_lines: 0, truncated: false, content: "", match_count: 0, search_regex: "y+" },
      ],
    });
    expect(blocks.map(b => b.text)).toEqual([`<!-- No matches for 'zzz' -->\n<!-- No matches for /y+/ -->\n`]);
  });

  it("files without matches are omitted when the same search matched elsewhere", () => {
    const blocks = formatReadContent({
      results: [
        { path: "/a.ts", mode_applied: "compact", lines: 100, returned_lines: 2, truncated: false, content: "7\timport { foo }\n91\tfoo()", match_count: 2, search_term: "foo" },
        { path: "/b.ts", mode_applied: "compact", lines: 50,  returned_lines: 0, truncated: false, content: "", match_count: 0, search_term: "foo" },
        { path: "/c.ts", mode_applied: "compact", lines: 30,  returned_lines: 0, truncated: false, content: "", match_count: 0, search_regex: "bar" },
      ],
    });
    expect(blocks.map(b => b.text)).toEqual([
      `<!-- 2 matches for 'foo' in '/a.ts' (100 lines) as compact -->\n7\timport { foo }\n91\tfoo()\n`,
      `<!-- No matches for /bar/ -->\n`,
    ]);
  });

  it("no-match lines are emitted even when the output budget is exhausted", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line-${i + 1}-${"z".repeat(20)}`).join("\n") + "\n";
    const blocks = formatReadContent(
      {
        results: [
          { path: "/big.txt", mode_applied: "verbatim", lines: 100, returned_lines: 100, truncated: false, content },
          { path: "/s.ts", mode_applied: "compact", lines: 10, returned_lines: 0, truncated: false, content: "", match_count: 0, search_term: "zzz" },
        ],
        sources: new Map([["/big.txt", content]]),
      },
      [],
      false,
      500,
    );
    const texts = blocks.map(b => b.text);
    expect(texts.at(-1)).toBe(`<!-- No matches for 'zzz' -->\n`);
    expect(texts.some(t => t.includes("could not return"))).toBe(false);
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
      `<!-- Line 168 to 179 of 262 lines in '/src/types.ts' as verbatim -->\nexport type EditFile = z.infer<typeof EditFile>;\n`
    );
  });

  it("full-file read: header shows the line count only", () => {
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
      `<!-- 50 lines in '/src/index.ts' as compact -->\nexport default function main() {}\n`
    );
  });
});

describe("formatEditContent", () => {
  it("single file OK: overview with file and op count", () => {
    const blocks = formatEditContent({
      results: [{ path: "/a.ts", status: "ok", ops: [], totalOps: 0 }],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- Edit: 1 file, 0 ops successful -->\n`);
  });

  it("dryRun OK: prefixed with DRY RUN", () => {
    const blocks = formatEditContent({ results: [{ path: "/a.ts", status: "ok", ops: [], totalOps: 0 }] }, [], false, true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(`<!-- DRY RUN: Edit: 1 file, 0 ops successful -->\n`);
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
    expect(blocks[0]!.text).toBe(`<!-- Edit: 3 files, 0 ops successful -->\n`);
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
    expect(blocks[0]!.text).toBe(`<!-- Edit: 1 file, 2 ops successful -->\n`);
  });

  it("single successful op: singular op label", () => {
    const blocks = formatEditContent({ results: [{ path: "/a.ts", status: "ok", ops: [], totalOps: 1 }] });
    expect(blocks[0]!.text).toBe(`<!-- Edit: 1 file, 1 op successful -->\n`);
  });

  it("user summary pluralises the file count", () => {
    const blocks = formatEditContent(
      { results: [{ path: "/a.ts", status: "ok", ops: [], totalOps: 1 }] },
      [{ path: "/a.ts", ops: [{ type: "replace", old: "a", new: "b" }] }],
      true,
    );
    expect(blocks[1]!.text).toContain("Edited 1 file ");
    expect(blocks[1]!.text).not.toContain("file(s)");
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
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/a.ts': 0/1 ops successful -->\n<!-- op (replace) old: "beta\\ngamma\\nDELTA"; error: try anchor below; possible verbatim anchor: lines 40-44 -->\nbeta\ngamma\nDELTA-changed\n`
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
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- '/a.ts': 0/1 ops successful -->\n<!-- op (replace) old: "### Fixed"; error: widen anchor; matches at lines 3, 17, 42 -->\n`
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
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- Error io_error: '/missing.ts' — not absolute -->\n`
    );
  });

  it("file-level error with empty message: reason only", () => {
    const blocks = formatEditContent({
      results: [{
        path: "/x.ts", status: "error", error: { reason: "not_authorized", message: "" }, totalOps: 1,
        ops: [{ index: 0, status: "error", type: "replace", reason: "not_authorized", hint: { next_action: "" } }],
      }],
    });
    expect(blocks[0]!.text).toBe(
      `<!-- Edit: 1 file, 0/1 ops successful -->\n\n<!-- Error not_authorized: '/x.ts' -->\n`
    );
  });

  it("file-level not_found shows the absolute path even below cwd", () => {
    const pattern = join(process.cwd(), "sub", "*.ts");
    const blocks = formatEditContent({
      results: [{
        path: pattern, status: "error", error: { reason: "not_found", message: "no files matched" }, totalOps: 1,
        ops: [{ index: 0, status: "error", type: "replace", reason: "not_found", hint: { next_action: "no files matched" } }],
      }],
    });
    expect(blocks[0]!.text).toContain(`<!-- Error not_found: '${pattern.split(sep).join("/")}' — no files matched -->`);
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
      `<!-- Edit: 1 file, 0/4 ops successful -->\n\n<!-- '/a.ts': 0/4 ops successful -->\n<!-- op (replace) old: "foo"; error: 'foo' not found in file -->\n<!-- op (write) mode: append; skipped -->\n<!-- op (replace_range) lines 10-12; skipped -->\n<!-- op (replace) old: "bar"; skipped -->\n`,
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
      { results: [{ path: "/big.txt", mode_applied: "verbatim", lines: 100, returned_lines: 100, truncated: false, content }], sources: new Map([["/big.txt", content]]) },
      [],
      false,
      800,
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    const m = text.match(/^<!-- Line 1 to (\d+) of 100 lines in '\/big\.txt' as verbatim -->/);
    expect(m).not.toBe(null);
    const endLine = Number(m![1]);
    expect(endLine).toBeLessThanOrEqual(99);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text.includes(`L${String(endLine).padStart(3, "0")}X`)).toBe(true);
    expect(text.includes(`L${String(endLine + 1).padStart(3, "0")}X`)).toBe(false);
    expect(text.includes(`Truncated at line ${endLine} of 100`)).toBe(true);
    expect(text.endsWith(`re-read from line ${endLine + 1} -->\n`)).toBe(true);
  });

  const truncatedCompactBlock = (source: string, path: string, start: number, lineCount: number, total: number) => {
    const body = formatForRead({ content: source, mode: "compact", path, offset: start, limit: lineCount }).content;
    const end = start + lineCount - 1;
    const range = lineCount === 1 ? `Line ${start}` : `Line ${start} to ${end}`;
    const marker = `<!-- Truncated at line ${end} of ${total} — max output reached; re-read from line ${end + 1} -->`;
    return `<!-- ${range} of ${total} lines in '${path}' as compact -->\n${body.endsWith("\n") ? body : `${body}\n`}${marker}\n`;
  };

  const compactOutput = (source: string, path: string, start: number, lineCount: number, total: number) => ({
    results: [{
      path,
      mode_applied: "compact" as const,
      lines: total,
      returned_lines: lineCount,
      start_line: start,
      truncated: false,
      content: formatForRead({ content: source, mode: "compact", path, offset: start, limit: lineCount }).content,
    }],
    sources: new Map([[path, source]]),
  });

  it("compact single-line output truncates by source lines, keeping as many as fit", () => {
    const source = Array.from({ length: 100 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n") + "\n";
    const blocks = formatReadContent(compactOutput(source, "/big.ts", 1, 100, 100), [], false, 600);
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    const kept = Number(text.match(/^<!-- Line 1 to (\d+) of 100 lines/)![1]);
    expect(kept).toBeLessThanOrEqual(99);
    expect(text).toBe(truncatedCompactBlock(source, "/big.ts", 1, kept, 100));
    expect(text.length).toBeLessThanOrEqual(600);
    expect(truncatedCompactBlock(source, "/big.ts", 1, kept + 1, 100).length).toBeGreaterThan(600);
  });

  it("compact indent-sensitive output with collapsed blank lines truncates by source lines", () => {
    const source = Array.from({ length: 60 }, (_, i) => `v${i + 1} = ${i + 1}\n\n\n`).join("");
    const blocks = formatReadContent(compactOutput(source, "/big.py", 1, 180, 180), [], false, 300);
    const text = blocks[0]!.text;
    const kept = Number(text.match(/^<!-- Line 1 to (\d+) of 180 lines/)![1]);
    expect(kept).toBeLessThanOrEqual(179);
    expect(text).toBe(truncatedCompactBlock(source, "/big.py", 1, kept, 180));
    expect(truncatedCompactBlock(source, "/big.py", 1, kept + 1, 180).length).toBeGreaterThan(300);
  });

  it("compact truncation of a slice keeps the requested start line", () => {
    const source = Array.from({ length: 100 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n") + "\n";
    const blocks = formatReadContent(compactOutput(source, "/big.ts", 10, 50, 100), [], false, 400);
    const text = blocks[0]!.text;
    const end = Number(text.match(/^<!-- Line 10 to (\d+) of 100 lines/)![1]);
    expect(end).toBeLessThanOrEqual(58);
    expect(text).toBe(truncatedCompactBlock(source, "/big.ts", 10, end - 9, 100));
  });

  it("compact truncation keeps at least one source line when nothing fits", () => {
    const source = Array.from({ length: 100 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n") + "\n";
    const blocks = formatReadContent(compactOutput(source, "/big.ts", 1, 100, 100), [], false, 10);
    expect(blocks[0]!.text).toBe(truncatedCompactBlock(source, "/big.ts", 1, 1, 100));
  });

  it("truncation stops later files; they are listed in a trailing omitted marker", () => {
    const contentA = makeLines(100).join("\n") + "\n";
    const blocks = formatReadContent(
      {
        results: [
          { path: "/a.txt", mode_applied: "verbatim", lines: 100, returned_lines: 100, truncated: false, content: contentA },
          { path: "/b.txt", mode_applied: "compact", lines: 3, returned_lines: 3, truncated: false, content: "b1\nb2\nb3\n" },
          { path: "/c.txt", mode_applied: "compact", lines: 2, returned_lines: 2, truncated: false, content: "c1\nc2\n" },
        ],
        sources: new Map([["/a.txt", contentA]]),
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
    expect(last.endsWith("-->\n")).toBe(true);
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

  it("search (count=0) truncates at a match-line boundary, keeping the match header", () => {
    const content = Array.from({ length: 40 }, (_, i) => `${(i + 1) * 3}\tmatchline-${String(i + 1).padStart(2, "0")}`).join("\n");
    const blocks = formatReadContent(
      { results: [{ path: "/s.ts", mode_applied: "compact", lines: 400, returned_lines: 40, truncated: false, content, match_count: 40 }] },
      [],
      false,
      500,
    );
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    expect(text.startsWith("<!-- 40 matches in '/s.ts' (400 lines) as compact -->")).toBe(true);
    expect(text.includes("matchline-01")).toBe(true);
    expect(text.includes("matchline-40")).toBe(false);
    expect(text.includes("of 40 match blocks")).toBe(true);
    expect(text.endsWith("-->\n")).toBe(true);
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
    expect(text.startsWith("<!-- 5 matches in '/s.ts' (200 lines) as verbatim -->")).toBe(true);
    expect(text.includes("ctx-010-a")).toBe(true);
    expect(text.includes("ctx-130-a")).toBe(false);
    expect(text.includes("match block")).toBe(true);
  });
});
