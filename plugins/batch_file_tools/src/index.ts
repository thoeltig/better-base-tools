import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EditInput, ReadInput } from "./types.js";
import { formatEditContent, formatReadContent } from "./lib/envelope.js";
import { handleBatchRead } from "./tools/read.js";
import { handleBatchEdit } from "./tools/edit.js";
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
    description: "Batch-read N files in one call. Mode per file: 'edit' = reading before an edit op (byte-exact + line-numbered so anchors match); 'info_compact' = DEFAULT for reading-to-understand (lossless whitespace collapse, saves tokens, not usable as edit anchor); 'info_verbatim' = reading-to-understand when on-disk formatting matters (byte-exact, no line numbers). Supports offset/limit per file. Line-number format in 'edit' mode: '{line}\\t{content}\\n' (tab-separated). Result: one text block per file — `<!-- Read N lines in file /path as 'mode' -->` hint on line 1, raw unescaped content below.",
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
    description: "Multi-file, multi-op edit in one call. Ops: replace, replace_all, insert_at_line, replace_range, write. `write` takes {mode: 'append'|'overwrite', content} and auto-creates missing files + parent dirs. Use replace with new='' to delete matched text. Execution order per file: (1) line-addressed ops (insert_at_line, replace_range) run first, sorted by anchor line DESC — so every line number you provide references the ORIGINAL file, never a post-edit offset. Overlapping phase-1 ranges error both conflicting ops. (2) content-addressed + file-wide ops (replace, replace_all, write) in the order you provided them. Output verbosity via `output: minimal|summary|diff` at root, file, or op level (op > file > root precedence). Default minimal = emit errored ops only. continueOnError + dryRun supported. Errors include a `nearest_anchor` verbatim window usable directly as the next `old` anchor when the needle isn't found. Result: one text block per file — multi-line `<!-- meta -->` header (file status + per-op status lines) followed by raw unescaped body (file-level diff, labeled per-op diff / `nearest_anchor` sub-blocks).",
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

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => await updateValidRootDirectories());

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();
  if (clientCapabilities?.roots) {
    await updateValidRootDirectories();
  }

  if(validRootDirectories.length > 0){
    writeLogLine(`Client supports MCP Roots: ${validRootDirectories.join(', ')}`);
  } else if (allowedDirectoriesFromArgs.length > 0) {
    writeLogLine(`Client doesn't support MCP Roots. Using allowed directories from args instead: ${allowedDirectoriesFromArgs.join(', ')}`);
  } else {
    writeLogLine(`No allowed directories were provided. Neither via args nor via MCP roots protocl. Server will be shut down.`);
    process.exit(1);
  }
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
  return validRootDirectories.length > 0 ? validRootDirectories : allowedDirectoriesFromArgs;
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
