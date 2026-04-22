#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EditInput, ReadInput } from "./types.js";
import { formatEditContent, formatReadContent } from "./lib/envelope.js";
import { handleBatchRead } from "./tools/read.js";
import { handleBatchEdit } from "./tools/edit.js";

const READ_TOOL = {
  name: "batch_read",
  description:
    "Batch-read N files in one call. Mode per file: 'edit' = reading before an edit op (byte-exact + line-numbered so anchors match); 'info_compact' = DEFAULT for reading-to-understand (lossless whitespace collapse, saves tokens, not usable as edit anchor); 'info_verbatim' = reading-to-understand when on-disk formatting matters (byte-exact, no line numbers). Supports offset/limit per file. Line-number format in 'edit' mode: '{line}\\t{content}\\n' (tab-separated). Result: one text block per file — `<!-- Read N lines in file /path as 'mode' -->` hint on line 1, raw unescaped content below.",
  inputSchema: {
    type: "object",
    properties: {
      requests: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path" },
            mode: {
              type: "string",
              enum: ["edit", "info_compact", "info_verbatim"],
              description:
                "edit=pre-edit reads (line-numbered, byte-exact). info_compact=default for info reads (lossless compact, saves tokens). info_verbatim=info reads when on-disk formatting matters (byte-exact, no line numbers).",
            },
            offset: {
              type: "integer",
              minimum: 1,
              description: "1-indexed start line",
            },
            limit: {
              type: "integer",
              minimum: 1,
              description: "Max lines to return",
            },
          },
          required: ["path", "mode"],
          additionalProperties: false,
        },
      },
    },
    required: ["requests"],
    additionalProperties: false,
  },
} as const;

const EDIT_TOOL = {
  name: "batch_edit",
  description:
    "Multi-file, multi-op edit in one call. Ops: replace, replace_all, insert_at_line, replace_range, append, delete, create, overwrite. Execution order per file: (1) line-addressed ops (insert_at_line, replace_range) run first, sorted by anchor line DESC — so every line number you provide references the ORIGINAL file, never a post-edit offset. Overlapping phase-1 ranges error both conflicting ops. (2) create. (3) content-addressed + file-wide ops (replace, replace_all, delete, append, overwrite) in the order you provided them. Output verbosity via `output: minimal|summary|diff` at root, file, or op level (op > file > root precedence). Default minimal = emit errored ops only. continueOnError + dryRun supported. Errors include a `nearest_anchor` verbatim window usable directly as the next `old` anchor when the needle isn't found. Result: one text block per file — multi-line `<!-- meta -->` header (file status + per-op status lines) followed by raw unescaped body (file-level diff, labeled per-op diff / `nearest_anchor` sub-blocks).",
  inputSchema: {
    type: "object",
    properties: {
      continueOnError: { type: "boolean", default: true },
      dryRun: { type: "boolean", default: false },
      output: {
        type: "string",
        enum: ["minimal", "summary", "diff"],
        default: "minimal",
        description:
          "Root default. Overridable at file level and op level. minimal = status + failed ops only. summary = per-op summary strings. diff = unified diffs (per-op when set on op, whole-file when set on file).",
      },
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            continueOnError: { type: "boolean" },
            output: {
              type: "string",
              enum: ["minimal", "summary", "diff"],
            },
            ops: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                description:
                  "Discriminated by 'type': replace {old,new} | replace_all {old,new} | insert_at_line {line,content} | replace_range {start,end,content} | append {content} | delete {old} | create {content} | overwrite {content}. Each op accepts optional `output: minimal|summary|diff`.",
              },
            },
          },
          required: ["path", "ops"],
          additionalProperties: false,
        },
      },
    },
    required: ["files"],
    additionalProperties: false,
  },
} as const;

const server = new Server(
  {
    name: "batch-file-tools",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [READ_TOOL, EDIT_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // structuredContent policy (see Claude_Temp_Files/dogfood-log.md):
    // DO NOT set on either tool. Claude Code's harness surfaces
    // structuredContent to the model in place of content[], which re-wraps
    // the per-file TextContent envelope in JSON and re-escapes every `\n` to
    // `\\n`. Emit unescaped raw text via content[] only.
    if (name === "batch_read") {
      const parsed = ReadInput.parse(args);
      const result = await handleBatchRead(parsed);
      return { content: formatReadContent(result) };
    }

    if (name === "batch_edit") {
      const parsed = EditInput.parse(args);
      const result = await handleBatchEdit(parsed);
      return { content: formatEditContent(result) };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: `Tool error: ${message}` }],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`batch-file-tools fatal: ${message}\n`);
  process.exit(1);
});
