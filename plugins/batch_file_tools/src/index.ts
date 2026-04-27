import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EditInput, EditTextInput, ReadInput } from "./types.js";
import { formatEditContent, formatReadContent } from "./lib/envelope.js";
import { handleBatchRead } from "./tools/read.js";
import { handleBatchEdit } from "./tools/edit.js";
import { handleBatchEditText } from "./tools/edit-text.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllowedDirectoriesFromArgs } from "./lib/fs.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { getValidRootDirectories } from "./lib/fs.js";
import { writeLogLine } from "./lib/log.js";

const args = process.argv.slice(2);
const allowedDirectoriesFromArgs = await getAllowedDirectoriesFromArgs(args);
let validRootDirectories: string[] = [];

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
    description: "Batch-read N files in one call. Mode per file: 'compact' = DEFAULT for reading-to-understand (lossy: collapses multi-whitespace runs, strips leading indent on non-indent-sensitive langs, minifies .json, collapses blank-line runs; not usable as edit anchor); 'verbatim' = reading-to-understand when on-disk formatting matters (byte-exact, no line numbers); 'verbatim_numbered' = byte-exact + line-numbered so anchors match — required before edit ops that use line anchors (insert_at_line / replace_range). Supports offset/limit per file. Line-number format in 'verbatim_numbered' mode: '{line}\\t{content}\\n' (tab-separated). Result: one text block per file — `<!-- Read N lines in file /path as 'mode' -->` hint on line 1, raw unescaped content below.",
    inputSchema: { param: ReadInput },
    annotations: {
      title: 'Improved read tool which supports batching and different read modes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ param }) => {
  try {
      const parsed = ReadInput.parse(param);
      const allowedDirectories = getAllowedDirectoriesToUse();
      const result = await handleBatchRead(parsed, allowedDirectories);
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
    description: "Multi-file, multi-op edit in one call. Ops: replace, replace_all, insert_at_line, replace_range, write. `write` takes {mode: 'append'|'overwrite', content} and auto-creates missing files + parent dirs. Glob/folder paths: `path` may be a glob (e.g. `C:/proj/**/*.ts`) or directory; ops apply to each matched file. Only `replace`, `replace_all`, and `write(append)` are supported across glob/folder paths. Use replace with new='' to delete matched text. Execution order per file: (1) line-addressed ops (insert_at_line, replace_range) run first, sorted by anchor line DESC — so every line number you provide references the ORIGINAL file, never a post-edit offset. Overlapping phase-1 ranges error both conflicting ops. (2) content-addressed + file-wide ops (replace, replace_all, write) in the order you provided them. Output verbosity via `verbose` boolean at root, file, or op level — default false (failed ops only); resolution op > file > root, first defined wins (explicit false overrides higher-level true). `stopOnError` boolean at root or file level — default false (continue on error); set true to skip remaining ops after a failure. Within-file resolution: file ?? root, first defined wins. Across-file abort uses root only. dryRun supported. Errors include a `nearest_anchor` verbatim window usable directly as the next `old` anchor when the needle isn't found. Result: one text block per file — multi-line `<!-- meta -->` header (file status + per-op status lines) followed by raw unescaped body for `nearest_anchor` sub-blocks.",
    inputSchema: { param: EditInput },
    annotations: {
      title: 'Improved edit tool which supports batching and different output modes',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  async ({ param }) => {
  try {
      const parsed = EditInput.parse(param);
      const allowedDirectories = getAllowedDirectoriesToUse();
      const result = await handleBatchEdit(parsed, allowedDirectories);
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
);

server.registerTool(
  "batch_edit_text",
  {
    title: "Line-based text-format variant of batch_edit (no JSON envelope per op)",
    description: "Same semantics as batch_edit but accepts edits as one line-based text blob — avoids per-op JSON envelopes and `\\n` escaping in multi-line content. Prefer this for medium/large multi-line edits; prefer batch_edit for small surgical replaces. GRAMMAR (line-based, column-0 sensitive): root scalars (optional, before first File:) — `stopOnError: true|false`, `dryRun: true|false`, `verbose: true|false`. Each file block starts with `File: <absolute path or glob>` followed by optional `stopOnError:`/`verbose:` (file-level overrides), then one or more Action blocks. ACTIONS: `replace` (OLD+NEW fences) | `replace_all` (OLD+NEW fences) | `insert_at_line` (`line: N` + NEW fence) | `replace_range` (`start: N` + `end: M` + NEW fence) | `write` (`mode: append|overwrite` + NEW fence). Each Action accepts optional `verbose: true|false`. FENCES: content between `<<<OLD` / `OLD>>>` and `<<<NEW` / `NEW>>>` is verbatim — newlines, quotes, backslashes are literal, no escaping. Sentinels are recognized only at column 0. COLLISION: if content contains `OLD>>>` or `NEW>>>` at column 0, use a unique suffix on both open and close — e.g. `<<<OLD#k1` ... `OLD#k1>>>`. Any indented line is content even if it looks like a header/fence. RESOLUTION: verbose op > file > root > false; stopOnError file > root > false (op-level not supported). EXAMPLE:\n```\nstopOnError: true\nFile: C:/proj/src/foo.ts\nAction: replace\n<<<OLD\nconst x = 1;\nOLD>>>\n<<<NEW\nconst x = 42;\nNEW>>>\nAction: insert_at_line\nline: 1\n<<<NEW\n// top of file\nNEW>>>\nFile: C:/proj/src/bar.ts\nAction: write\nmode: append\n<<<NEW\n// appended\nNEW>>>\n```\nERRORS: parser errors surface as `reason: \"unparseable\"` with line number in `message`. Recovery is per-Action via opening-fence + Action lookback; an unparseable Action does not abort the file unless stopOnError is set. Files with no parseable ops emit as a single `unparseable` file error. Runtime errors (anchor not found, file not writable, etc.) match batch_edit including `nearest_anchor` hints. Output shape matches batch_edit (one text block per file).",
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
);

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => await updateValidRootDirectories());

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();
  if (clientCapabilities?.roots) {
    await updateValidRootDirectories();
  }

  if (getAllowedDirectoriesToUse().length === 0) {
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

function getAllowedDirectoriesToUse(): string[] {
  return [...new Set([...validRootDirectories, ...allowedDirectoriesFromArgs])];
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
