import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { EditInput, ReadInput, ToolContentResult } from "./types.js";
import { formatEditContent, formatReadContent } from "./lib/envelope.js";
import { handleBatchRead } from "./tools/read.js";
import { handleBatchEdit } from "./tools/edit.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllowedDirectoriesFromArgs, getValidRootDirectories, isPathAllowed } from "./lib/fs.js";
import { looksLikeGlob } from "./lib/glob.js";
import { RootsListChangedNotificationSchema, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PrimitiveSchemaDefinition, ServerRequest, ServerNotification, LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const args = process.argv.slice(2);
const allowedDirectoriesFromArgs = await getAllowedDirectoriesFromArgs(args);
let validRootDirectories: string[] = [];
const sessionAllowedReadPaths: string[] = [];
const sessionAllowedEditPaths: string[] = [];

// MCP harnesses like Claude Code do not support some features of the MCP protocol. Logging falls back to console.error for errors only which is the default.
const USE_MCP_LOGGING = parseConfigArg('mcp-logging', 'BATCH_TOOLS_MCP_LOGGING', 'false') === 'true';
const USE_USER_AUDIENCE = parseConfigArg('user-audience', 'BATCH_TOOLS_MCP_ANNOTATIONS_USER_AUDIENCE', 'false') === 'true';
const READ_META = parseConfigArgRecord('read-meta', 'BATCH_TOOLS_READ_META');
const EDIT_META = parseConfigArgRecord('edit-meta', 'BATCH_TOOLS_EDIT_META');
const DRY_RUN = parseConfigArg('dry-run', 'BATCH_TOOLS_DRY_RUN', 'false') === 'true';
const NORMALIZE_FORMATTING = parseConfigArg('normalize-formatting', 'BATCH_TOOLS_NORMALIZE_FORMATTING', 'true') === 'true';
const USE_STRUCTURED_CONTENT = parseConfigArg('mcp-structured-content', 'BATCH_TOOLS_MCP_STRUCTURED_CONTENT', 'false') === 'true';

function parseConfigArg(argName: string, envName: string, defaultVal: string): string {
  const envVal = process.env[envName];
  if (envVal !== undefined && envVal !== '') return envVal;
  const prefix = `--${argName}=`;
  const exact = process.argv.find(a => a.startsWith(prefix));
  if (exact) return exact.slice(prefix.length);
  const idx = process.argv.indexOf(`--${argName}`);
  if (idx >= 0) {
    if (process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('--')) return process.argv[idx + 1]!;
    return 'true';
  }
  return defaultVal;
}

function parseConfigArgRecord(argName: string, envName: string): Record<string, unknown> {
  const raw = parseConfigArg(argName, envName, '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    console.error(`[config] ${envName}: expected a JSON object, ignoring`);
  } catch {
    console.error(`[config] ${envName}: invalid JSON, ignoring`);
  }
  return {};
}

const server = new McpServer(
  {
    name: "batch-tools-mcp-server",
    version: "1.1.7",
  },
  {
    capabilities: {
      tools: {},
      logging: {}
    },
  },
);


function writeMcpLogLine(level: LoggingLevel, data: string, logger?: string): void {
  if (USE_MCP_LOGGING) {
    try {
      server.sendLoggingMessage({ level, data, logger });
    } catch {
      console.error(`[${logger ?? 'server'}] ${data}`);
    }
  } else if (level === 'error') {
    console.error(`[${logger ?? 'server'}] ${data}`);
  }
}

function createOutputMessage(msg: string, isError?: boolean | undefined): {
  isError: boolean | undefined;
  content: ToolContentResult[];
}{
  return { 
    isError, 
    content: [{ 
      type: 'text', 
      text: isError ? `Error: ${msg}` : msg,
      annotations: {
        audience: ["assistant", "user"],
        priority: 0
      }
    }]
  };
}


async function reportProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  progress: number,
  total: number,
  message?: string
): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { 
        progressToken: token, 
        progress, 
        total, 
        message 
      },
    });
  } catch { /* ignore if client doesn't support progress */ }
}

server.registerTool(
  "batch_read",
  {
    title: "Improved read tool which supports batching and different read modes",
    description: "Batch-read N files in one call. Mode per file: 'compact'=DEFAULT — lowest token cost; strips indent/whitespace; use for full-file reads and as replace/replace_all anchor. 'verbatim'= exact content, no line numbers — full-file anchor for replace/replace_all when whitespace normalization would break the match. 'verbatim_numbered'= line-numbered (format: '{line}\\t{content}') — requires searchTerm or offset/count (enforced); returned line numbers anchor replace_range/insert_at_line ops. 'fileinfo'= metadata (size, lines, ISO mtime, isFile) plus refs[] of resolved file references. Mode→op pairing: compact → replace/replace_all | verbatim → replace/replace_all | verbatim_numbered+searchTerm/offset → replace_range/insert_at_line. Path: absolute or relative file, directory (expands to immediate children) or glob (e.g. proj/**/*.ts); all modes support glob/directory. Pagination: 'offset' (1-indexed start line) + 'count' (max lines). Search: 'searchTerm' (case-insensitive) + 'count' (context lines around each match, default 0). Use cases — follow this cascade for unknown files: (1) fileinfo — check size+lines before reading content, map deps via refs[]; (2) compact — full-file overview or replace/replace_all anchor (lowest token cost); (3) verbatim — full-file replace anchor when compact whitespace stripping would break the match; (4) verbatim_numbered+searchTerm or +offset+count — targeted slice with line numbers for replace_range/insert_at_line. Other use cases: (5) multi-file scan — searchTerm+glob finds occurrences across files without full reads; (6) dependency map — fileinfo+glob returns metadata+refs[] per file; (7) safe global replace — compact+searchTerm to verify occurrences, then replace_all;",
    inputSchema: ReadInput,
    annotations: {
      title: 'Improved read tool which supports batching and different read modes',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    _meta: READ_META
  },
  async (param, extra) => {
  try {
      const parsed = ReadInput.parse(param);
      writeMcpLogLine("info", `batch_read — ${parsed.requests.length} request(s)`, "batch_read");
      const allowedDirectories = getAllowedDirectoriesToUse("read");
      const pathInfos = parsed.requests.map(r => {
        const parts = [`mode: ${r.mode}`];
        if (r.searchTerm) parts.push(`search: "${r.searchTerm}"`);
        return { path: isAbsolute(r.path) ? r.path : resolve(r.path), detail: parts.join(", ") };
      });
      const sessionAllowed = await elicitPaths(pathInfos, allowedDirectories, "batch_read", "read");
      const effectiveAllowed = sessionAllowed.length > 0
        ? [...allowedDirectories, ...sessionAllowed]
        : allowedDirectories;
      const result = await handleBatchRead(parsed, effectiveAllowed, NORMALIZE_FORMATTING, (done, total) => reportProgress(extra, done, total));
      const errCount = result.results.filter(r => r.error).length;
      const okCount = result.results.length - errCount;
      writeMcpLogLine("info", errCount > 0 ? `batch_read done — ${okCount} ok, ${errCount} error(s)` : `batch_read done — ${okCount} file(s)`, "batch_read");
      const toolOutput: CallToolResult = { content: formatReadContent(result, parsed.requests, USE_USER_AUDIENCE) };
      if(USE_STRUCTURED_CONTENT) toolOutput.structuredContent = result;
      return toolOutput;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine("error", `batch_read error — ${message}`, "batch_read");
      return createOutputMessage(message, true);
    }
  }
);

server.registerTool(
  "batch_edit",
  {
    title: "Improved edit tool which supports batching and different output modes",
    description: "Multi-file, multi-op edit in one call. Ops: replace, replace_all, insert_at_line, replace_range, write. write auto-creates files and parent dirs; supports append or overwrite. Use replace with new='' to delete text. Glob/folder path: ops apply to each matched file; only replace, replace_all, and write(append) supported across globs. Execution order per file: (1) line-addressed ops (insert_at_line, replace_range) run first, sorted DESC by anchor line — line numbers always reference the ORIGINAL file, never a post-edit offset; overlapping ranges error. (2) content-addressed ops (replace, replace_all, write) run in order given. stopOnError flags available at root, file, and op level — lower levels override upper. Op selection — match the op to how you read the file: compact or verbatim → replace/replace_all (use read content as anchor); verbatim_numbered+searchTerm/offset → replace_range/insert_at_line (use returned line numbers; do not use replace — it wastes the line anchors). Errors include a nearest_anchor hint usable directly as the next old anchor. Use cases: (1) full-file edit — read compact or verbatim, use replace/replace_all; (2) targeted edit — read verbatim_numbered+searchTerm or +offset+count, use replace_range/insert_at_line with the returned line numbers; (3) multi-file refactor — replace_all+glob to rename a symbol across all matching files; (4) new file — write(overwrite) auto-creates file and any missing parent dirs; (5) safe bulk replace — batch_read searchTerm first to verify all occurrences, then replace_all with confidence; (6) multi-line content — prefer replace_range/insert_at_line over replace to avoid JSON-escaping newlines in old/new strings.",
    inputSchema: EditInput,
    annotations: {
      title: 'Improved edit tool which supports batching and different output modes',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    _meta: EDIT_META
  },
  async (param, extra) => {
  try {
      const parsed = EditInput.parse(param);
      const totalOps = parsed.files.reduce((s, f) => s + f.ops.length, 0);
      writeMcpLogLine("info", `batch_edit — ${parsed.files.length} file(s), ${totalOps} op(s)`, "batch_edit");
      const allowedDirectories = getAllowedDirectoriesToUse("edit");
      const pathInfos = parsed.files.map(f => ({
        path: isAbsolute(f.path) ? f.path : resolve(f.path),
        detail: `ops: ${[...new Set(f.ops.map(o => o.type))].join(", ")}`,
      }));
      const sessionAllowed = await elicitPaths(pathInfos, allowedDirectories, "batch_edit", "edit");
      const effectiveAllowed = sessionAllowed.length > 0
        ? [...allowedDirectories, ...sessionAllowed]
        : allowedDirectories;
      const result = await handleBatchEdit(parsed, effectiveAllowed, DRY_RUN, (done, total) => reportProgress(extra, done, total));
      const okCount = result.results.filter(r => r.status === "ok").length;
      const errCount = result.results.filter(r => r.status === "error" || r.status === "partial").length;
      writeMcpLogLine("info", errCount > 0 ? `batch_edit done — ${okCount} ok, ${errCount} error/partial` : `batch_edit done — ${okCount} file(s)`, "batch_edit");
      const toolOutput: CallToolResult = { content: formatEditContent(result, parsed.files, USE_USER_AUDIENCE, DRY_RUN) };
      if(USE_STRUCTURED_CONTENT) toolOutput.structuredContent = result;
      return toolOutput;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine("error", `batch_edit error — ${message}`, "batch_edit");
      return createOutputMessage(message, true);
    }
  }
);

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => await updateValidRootDirectories());

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();
  if (clientCapabilities?.roots) {
    await updateValidRootDirectories();
  }

  if (getAllowedDirectoriesToUse("read").length === 0) {
    writeMcpLogLine("error", `No allowed directories provided via args or MCP roots. Server will be shut down.`, 'permissions');
    process.exit(1);
  }

  const parts: string[] = [];
  if (validRootDirectories.length > 0) parts.push(`roots=[${validRootDirectories.join(', ')}]`);
  if (allowedDirectoriesFromArgs.length > 0) parts.push(`args=[${allowedDirectoriesFromArgs.join(', ')}]`);
  writeMcpLogLine("info", `Allowed directories — ${parts.join(' + ')}`, 'permissions');
};

async function updateValidRootDirectories() {
  try {
    const response = await server.server.listRoots();
    if (response && 'roots' in response) {
      validRootDirectories = await getValidRootDirectories(response.roots, writeMcpLogLine);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeMcpLogLine("error", `Failed to request roots from client: ${message}`, 'permissions');
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
    if (isPathAllowed(p, sessionList)) {
      writeMcpLogLine("info", `elicit skip (session-allowed) — ${p}`, 'permissions');
      acceptedPaths.push(p);
      continue;
    }

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

      if (r.action !== "accept") {
        writeMcpLogLine("info", `elicit deny — ${p}`, 'permissions');
        continue;
      }

      acceptedPaths.push(p);

      const content = r.content as Record<string, unknown>;
      const sessionAllow = Array.isArray(content['session_allow']) ? content['session_allow'] as string[] : [];

      const sessionScope = sessionAllow.includes("folder") ? "folder" : sessionAllow.includes("file") ? "file" : "none";
      writeMcpLogLine("info", `elicit accept — ${p} (session: ${sessionScope})`, 'permissions');

      if (sessionAllow.includes("folder")) {
        sessionList.push(folder);
      } else if (sessionAllow.includes("file")) {
        sessionList.push(p);
      }
    } catch (err) {
      writeMcpLogLine("warning", `elicit error — ${p}: ${err instanceof Error ? err.message : String(err)}`, 'permissions');
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
  console.error(`batch-tools-mcp-server fatal: ${message}`);
  process.exit(1);
});