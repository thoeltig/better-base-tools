import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, isAbsolute } from "node:path";
import { EditInput, ReadInput } from "./types.js";
import { formatEditContent, formatReadContent } from "./lib/envelope.js";
import { handleBatchRead } from "./tools/read.js";
import { handleBatchEdit } from "./tools/edit.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllowedDirectoriesFromArgs, getValidRootDirectories, isPathAllowed } from "./lib/fs.js";
import { looksLikeGlob } from "./lib/glob.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PrimitiveSchemaDefinition } from "@modelcontextprotocol/sdk/types.js";
import { writeLogLine } from "./lib/log.js";

const args = process.argv.slice(2);
const allowedDirectoriesFromArgs = await getAllowedDirectoriesFromArgs(args);
let validRootDirectories: string[] = [];
const sessionAllowedReadPaths: string[] = [];
const sessionAllowedEditPaths: string[] = [];

// structuredContent policy (see Claude_Temp_Files/dogfood-log.md):
// DO NOT set on either tool. Claude Code's harness surfaces
// structuredContent to the model in place of content[], which re-wraps
// the per-file TextContent envelope in JSON and re-escapes every `\n` to
// `\\n`. Emit unescaped raw text via content[] only.

const server = new McpServer(
  {
    name: "batch-tools-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.registerTool(
  "batch_read",
  {
    title: "Improved read tool which supports batching and different read modes",
    description: "Batch-read N files in one call. Mode per file: 'compact'=DEFAULT (single-line collapsed, strips indent, consecutive whitespace and new lines — cheapest read for information retrieval). 'verbatim'= no line numbers — use as readable anchor. 'verbatim_numbered'= line-numbered (format: '{line}\\t{content}') — use for edit anchors (insert_at_line, replace_range) or with searchTerm for absolute line positions. 'fileinfo'= file metadata (size, lines, ISO mtime, isFile) plus refs[] which contains related and mentioned files — use to map file dependencies before exploring. Path: absolute file, directory (expands to immediate children) or glob (e.g. /proj/**/*.ts); all modes support glob/directory. Pagination: 'offset' (1-indexed start line) + 'count' (max lines). Search: 'searchTerm' (case-insensitive match) + 'count' (lines around the match, default 0). Use cases: (1) unknown file — fileinfo first, check size+lines, then choose mode + offset+count; (1b) dependency map — fileinfo on a file or glob returns metadata + import graph in one call; (2) multi-file scan — searchTerm + glob finds occurrences without full reads; (3) edit prep — verbatim_numbered + searchTerm gives absolute line anchors for replace_range / insert_at_line; (4) safe global replace — search first to verify all occurrences, then replace_all. Note: compact is for information gathering rather than edit anchors. In case you do use compact content as anchors for editing, whitespace mismatches are handled by fuzzy matching, but prefer the two verbatim modes for intended edits. verbatim/verbatim_numbered normalize indentation to 2 spaces/level by default; set disableNormalizedFormatting:true to receive raw file formatting.",
    inputSchema: ReadInput,
    annotations: {
      title: 'Improved read tool which supports batching and different read modes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async (param) => {
  try {
      const parsed = ReadInput.parse(param);
      const allowedDirectories = getAllowedDirectoriesToUse("read");
      const pathInfos = parsed.requests.map(r => {
        const parts = [`mode: ${r.mode}`];
        if (r.searchTerm) parts.push(`search: "${r.searchTerm}"`);
        return { path: r.path, detail: parts.join(", ") };
      });
      const sessionAllowed = await elicitPaths(pathInfos, allowedDirectories, "batch_read", "read");
      const effectiveAllowed = sessionAllowed.length > 0
        ? [...allowedDirectories, ...sessionAllowed]
        : allowedDirectories;
      const result = await handleBatchRead(parsed, effectiveAllowed);
      return { 
        content: formatReadContent(result)
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const logLine = `Tool error: ${message}`;
      writeLogLine(logLine);
      return {
        isError: true,
        content: [{ type: "text", text: logLine }],
      };
    }
  }
);

server.registerTool(
  "batch_edit",
  {
    title: "Improved edit tool which supports batching and different output modes",
    description: "Multi-file, multi-op edit in one call. Ops: replace, replace_all, insert_at_line, replace_range, write. write auto-creates files and parent dirs; supports append or overwrite. Use replace with new='' to delete text. Glob/folder path: ops apply to each matched file; only replace, replace_all, and write(append) supported across globs. Execution order per file: (1) line-addressed ops (insert_at_line, replace_range) run first, sorted DESC by anchor line — line numbers always reference the ORIGINAL file, never a post-edit offset; overlapping ranges error. (2) content-addressed ops (replace, replace_all, write) run in order given. stopOnError flags available at root, file, and op level — lower levels override upper. dryRun supported. Errors include a nearest_anchor hint usable directly as the next old anchor. Use cases: (1) targeted edit — read file in verbatim_numbered, use line numbers as replace_range / insert_at_line anchors; (2) multi-file refactor — replace_all + glob to rename a symbol across all matching files; (3) new file — write(overwrite) auto-creates file and any missing parent dirs; (4) safe bulk replace — batch_read searchTerm first to verify all occurrences, then replace_all with confidence; (5) multi-line content — read verbatim_numbered for line anchors, use replace_range or insert_at_line instead of replace/replace_all to avoid JSON-escaping newlines and special chars in old/new strings.",
    inputSchema: EditInput,
    annotations: {
      title: 'Improved edit tool which supports batching and different output modes',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async (param) => {
  try {
      const parsed = EditInput.parse(param);
      const allowedDirectories = getAllowedDirectoriesToUse("edit");
      const pathInfos = parsed.files.map(f => ({
        path: f.path,
        detail: `ops: ${[...new Set(f.ops.map(o => o.type))].join(", ")}`,
      }));
      const sessionAllowed = await elicitPaths(pathInfos, allowedDirectories, "batch_edit", "edit");
      const effectiveAllowed = sessionAllowed.length > 0
        ? [...allowedDirectories, ...sessionAllowed]
        : allowedDirectories;
      const result = await handleBatchEdit(parsed, effectiveAllowed);
      return { 
        content: formatEditContent(result, parsed.dryRun)
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const logLine = `Tool error: ${message}`;
      writeLogLine(logLine);
      return {
        isError: true,
        content: [{ type: "text", text: logLine }],
      };
    }
  }
);

/* 
Commented out for now to let the model focus on a single edit tool. Test if behavior changes.
Lately the model switches between edit tools and sometimes it confuses which schema each tool needs. If JSON only is easier it might be enough benefit.

server.registerTool(
  "batch_edit_text",
  {
    title: "Line-based text-format variant of batch_edit (no JSON envelope per op)",
    description: "Same semantics as batch_edit but accepts edits as one line-based text blob — avoids per-op JSON envelopes. Prefer when ops are content-heavy (≥~15 lines per op); for small/many ops (≤~5 lines per op) prefer batch_edit. GRAMMAR (line-based, column-0 sensitive): root scalars (optional, before first File:) — `stopOnError: true|false`, `dryRun: true|false`, `verbose: true|false`. Each file block starts with `File: <absolute path or glob>` followed by optional `stopOnError:`/`verbose:` (file-level overrides), then one or more Action blocks. ACTIONS: `replace` (OLD+NEW fences) | `replace_all` (OLD+NEW fences) | `insert_at_line` (`line: N` + NEW fence) | `replace_range` (`start: N` + `end: M` + NEW fence) | `write` (`mode: append|overwrite` + NEW fence). Each Action accepts optional `verbose: true|false` and `stopOnError: true|false`. FENCES: content between `<<<OLD` / `OLD>>>` and `<<<NEW` / `NEW>>>` is verbatim. Sentinels are recognized only at column 0. COLLISION: if content contains `OLD>>>` or `NEW>>>` at column 0, use a unique suffix on both open and close — e.g. `<<<OLD#k1` ... `OLD#k1>>>`. Any indented line is content even if it looks like a header/fence. RESOLUTION: verbose op > file > root > false; stopOnError op > file > root > false. EXAMPLE:\n```\nstopOnError: true\nFile: C:/proj/src/foo.ts\nAction: replace\n<<<OLD\nconst x = 1;\nOLD>>>\n<<<NEW\nconst x = 42;\nNEW>>>\nAction: insert_at_line\nline: 1\n<<<NEW\n// top of file\nNEW>>>\nFile: C:/proj/src/bar.ts\nAction: write\nmode: append\n<<<NEW\n// appended\nNEW>>>\n```\nERRORS: parser errors surface as `reason: \"unparseable\"` with line number in `message`. Recovery is per-Action via opening-fence + Action lookback; an unparseable Action does not abort the file unless stopOnError is set. Files with no parseable ops emit as a single `unparseable` file error. Runtime errors (anchor not found, file not writable, etc.) match batch_edit including `nearest_anchor` hints. Output shape matches batch_edit (one text block per file).",
    inputSchema: { param: EditTextInput },
    annotations: {
      title: 'Line-based text-format variant of batch_edit (no JSON envelope per op)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ param }) => {
  try {
      const parsed = EditTextInput.parse(param);
      const allowedDirectories = getAllowedDirectoriesToUse();
      const result = await handleBatchEditText(parsed, allowedDirectories);
      return {
        content: formatEditContent(result)
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const logLine = `Tool error: ${message}`;
      writeLogLine(logLine);
      return {
        isError: true,
        content: [{ type: "text", text: logLine }],
      };
    }
  }
); */

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => await updateValidRootDirectories());

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();
  if (clientCapabilities?.roots) {
    await updateValidRootDirectories();
  }

  if (getAllowedDirectoriesToUse("read").length === 0) {
    writeLogLine(`No allowed directories provided via args or MCP roots. Server will be shut down.`);
    process.exit(1);
  }

  const parts: string[] = [];
  if (validRootDirectories.length > 0) parts.push(`roots=[${validRootDirectories.join(', ')}]`);
  if (allowedDirectoriesFromArgs.length > 0) parts.push(`args=[${allowedDirectoriesFromArgs.join(', ')}]`);
  writeLogLine(`Allowed directories — ${parts.join(' + ')}`);
};

async function updateValidRootDirectories() {
  try {
    const response = await server.server.listRoots();
    if (response && 'roots' in response) {
      validRootDirectories = await getValidRootDirectories(response.roots);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeLogLine(`Failed to request roots from client: ${message}`);
  }
}

function getAllowedDirectoriesToUse(toolType: "read" | "edit"): string[] {
  const sessionPaths = toolType === "read" ? sessionAllowedReadPaths : sessionAllowedEditPaths;
  return [...new Set([...validRootDirectories, ...allowedDirectoriesFromArgs, ...sessionPaths])];
}

async function elicitPaths(
  pathInfos: { path: string; detail: string }[],
  allowedDirs: string[],
  toolName: string,
  toolType: "read" | "edit",
): Promise<string[]> {
  const unauthorized = [...new Set(
    pathInfos
      .filter(pi => isAbsolute(pi.path) && !looksLikeGlob(pi.path) && !isPathAllowed(pi.path, allowedDirs))
      .map(pi => pi.path)
  )];
  if (unauthorized.length === 0 || !server.server.getClientCapabilities()?.elicitation) return [];

  const sessionList = toolType === "read" ? sessionAllowedReadPaths : sessionAllowedEditPaths;
  const acceptedPaths: string[] = [];

  for (const p of unauthorized) {
    const info = pathInfos.find(pi => pi.path === p);
    const detail = info?.detail ?? "";
    const folder = dirname(p);

    const props: Record<string, PrimitiveSchemaDefinition> = {
      session_allow: {
        type: "array" as const,
        title: "Also add to session allow list (optional)",
        items: { anyOf: [
          { const: "file", title: `File: ${p}` },
          { const: "folder", title: `Folder: ${folder}` },
        ]},
      },
    };

    const msg = detail
      ? `${toolName} — ${p}  (${detail})`
      : `${toolName} — ${p}`;
    try {
      const r = await server.server.elicitInput({
        message: msg,
        requestedSchema: { type: "object" as const, properties: props },
      });

      if (r.action !== "accept") continue;

      acceptedPaths.push(p);

      const content = r.content as Record<string, unknown>;
      const sessionAllow = Array.isArray(content['session_allow']) ? content['session_allow'] as string[] : [];

      if (sessionAllow.includes("folder")) {
        sessionList.push(folder);
      } else if (sessionAllow.includes("file")) {
        sessionList.push(p);
      }
    } catch {
      // elicitation error for this file, skip it
    }
  }

  return acceptedPaths;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  writeLogLine(`batch-tools-mcp-server fatal: ${message}`);
  process.exit(1);
});

/*
JSON repair — assessment 2026-05-14
Issue: ~1 in 30-50 batch_edit calls fail on malformed JSON (unescaped newlines / missing brackets
in LLM-generated old/new/content fields). Mostly complex nested edits.

Previous draft (handleMessage override) is wrong: by the time handleMessage fires, the SDK
transport has already called JSON.parse on the raw NDJSON line. `arguments` is an object,
not a string, so `typeof rawArgs === 'string'` is always false and repair is never invoked.

Correct intercept: Transform stream on raw stdin BEFORE transport creation.
- Buffer each NDJSON line, run `jsonrepair` (npm), re-emit the repaired line.
- Use `jsonrepair` npm package — well-tested against LLM output patterns (unescaped \n,
  dangling quotes, missing brackets). Build custom only if per-op/per-file recovery is needed
  (parse outer structure, mark individual broken ops as "unparseable" without failing the call).

TODO: implement stdin Transform wrapper; add `jsonrepair` dependency.

import { jsonrepair } from "jsonrepair";
import { Transform } from "node:stream";

const repairer = new Transform({
  transform(chunk, _enc, cb) {
    try { cb(null, jsonrepair(chunk.toString())); } catch { cb(null, chunk); }
  }
});
process.stdin.pipe(repairer);
const transport = new StdioServerTransport({ stdin: repairer as any, stdout: process.stdout });
await server.connect(transport);
*/