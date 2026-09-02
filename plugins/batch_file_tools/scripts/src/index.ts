import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { EditInput, ReadInput, ToolContentResult } from "./types.js";
import { formatEditContent, formatReadContent } from "./lib/envelope.js";
import { handleBatchRead } from "./tools/read.js";
import { handleBatchEdit } from "./tools/edit.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, resolveExcludePaths, getValidRootDirectories, isPathAllowed, isAccessible } from "./lib/fs.js";
import { looksLikeGlob } from "./lib/glob.js";
import { RootsListChangedNotificationSchema, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PrimitiveSchemaDefinition, ServerRequest, ServerNotification, LoggingLevel } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

const args = process.argv.slice(2);
let validRootDirectories: string[] = [];
const sessionAllowedReadPaths: string[] = [];
const sessionAllowedEditPaths: string[] = [];

// MCP harnesses like Claude Code do not support some features of the MCP protocol. Logging falls back to console.error for errors only which is the default.
const USE_MCP_LOGGING = parseConfigArg('mcp-logging', 'BATCH_TOOLS_MCP_LOGGING', 'false') === 'true';
const USE_USER_AUDIENCE = parseConfigArg('user-audience', 'BATCH_TOOLS_MCP_ANNOTATIONS_USER_AUDIENCE', 'false') === 'true';
const READ_META = parseConfigArgRecord('read-meta', 'BATCH_TOOLS_READ_META');
const EDIT_META = parseConfigArgRecord('edit-meta', 'BATCH_TOOLS_EDIT_META');
const DRY_RUN = parseConfigArg('dry-run', 'BATCH_TOOLS_DRY_RUN', 'false') === 'true';
const USE_STRUCTURED_CONTENT = parseConfigArg('mcp-structured-content', 'BATCH_TOOLS_MCP_STRUCTURED_CONTENT', 'false') === 'true';
const INCLUDE_PATHS_RAW = parseConfigArg('include', 'BATCH_TOOLS_INCLUDE_PATHS', '').split(',').filter(Boolean);
const EXCLUDE_PATHS_RAW = parseConfigArg('exclude', 'BATCH_TOOLS_EXCLUDE_PATHS', '').split(',').filter(Boolean);
const _maxOutputTokensParsed = parseInt(parseConfigArg('max-output-tokens', 'BATCH_TOOLS_MAX_OUTPUT_TOKENS', '75000'), 10);
const MAX_OUTPUT_TOKENS = isNaN(_maxOutputTokensParsed) ? 75000 : _maxOutputTokensParsed;
const CHARS_PER_TOKEN_OUTPUT = parseFloat(parseConfigArg('chars-per-token', 'BATCH_TOOLS_CHARS_PER_TOKEN', '2.5')) || 2.5;
const MAX_OUTPUT_CHARS = Math.floor(MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN_OUTPUT);
const allowedExtraPaths = await resolvePaths([...args.filter(a => isAbsolute(a) && !a.startsWith('--')), ...INCLUDE_PATHS_RAW]);

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
    version: "1.2.6",
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
    title: "Batch read files",
    description: "Batch-read N files in one call — bundle every file a task needs into one request instead of reading them one at a time. Anchoring contract with batch_edit: a full read (either mode) anchors replace/replace_all with the text it returned; a sliced read (offset/count) or a searchTerm read anchors replace_range/insert_at_line with the line numbers in its output header. Strategy: to locate code, prefer a searchTerm read across a glob over reading whole files; before a replace_all, run the same search to confirm how many occurrences exist.",
    inputSchema: ReadInput,
    annotations: {
      title: 'Batch read files',
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
      const resolvedExcludePaths = await resolveExcludePaths(EXCLUDE_PATHS_RAW, [...validRootDirectories, ...allowedExtraPaths]);
      const pathInfos = parsed.requests.map(r => {
        const parts = [`mode: ${r.mode}`];
        if (r.searchTerm) parts.push(`search: "${r.searchTerm}"`);
        return { path: isAbsolute(r.path) ? r.path : resolve(r.path), detail: parts.join(", ") };
      });
      const sessionAllowed = await elicitPaths(pathInfos, allowedDirectories, "batch_read", "read", resolvedExcludePaths);
      const effectiveAllowed = sessionAllowed.length > 0
        ? [...allowedDirectories, ...sessionAllowed]
        : allowedDirectories;
      const approvedPaths = [...new Set([...sessionAllowedReadPaths, ...sessionAllowed])];
      const result = await handleBatchRead(parsed, effectiveAllowed, resolvedExcludePaths, approvedPaths, (done, total) => reportProgress(extra, done, total));
      const errCount = result.results.filter(r => r.error).length;
      const okCount = result.results.length - errCount;
      writeMcpLogLine("info", errCount > 0 ? `batch_read done — ${okCount} ok, ${errCount} error(s)` : `batch_read done — ${okCount} file(s)`, "batch_read");
      const toolOutput: CallToolResult = {
        content: formatReadContent(result, parsed.requests, USE_USER_AUDIENCE, MAX_OUTPUT_CHARS),
      };
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
    title: "Batch edit files",
    description: "Multi-file, multi-op edit in one call — bundle every change a task needs into one request. Execution order per file: line-addressed ops (insert_at_line, replace_range) run first, sorted DESC by anchor line, so every line number refers to the ORIGINAL file and never to a post-edit offset; overlapping ranges error. Content-addressed ops (replace, replace_all, write) then run in the order given. Anchoring contract with batch_read: a full read anchors replace/replace_all with the text it returned; a sliced or searchTerm read anchors replace_range/insert_at_line with the line numbers in its output header — do not fall back to replace there, it discards line anchors already paid for. A failed anchor returns a nearest_anchor hint pasteable directly as the next 'old'. Strategy: replace_all over a glob or directory path renames a term across a whole tree in one op — confirm the occurrence count with a batch_read searchTerm over the same glob first; for multi-line content prefer replace_range/insert_at_line over escaping newlines into old/new.",
    inputSchema: EditInput,
    annotations: {
      title: 'Batch edit files',
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
      const resolvedExcludePaths = await resolveExcludePaths(EXCLUDE_PATHS_RAW, [...validRootDirectories, ...allowedExtraPaths]);
      const pathInfos = parsed.files.map(f => ({
        path: isAbsolute(f.path) ? f.path : resolve(f.path),
        detail: `ops: ${[...new Set(f.ops.map(o => o.type))].join(", ")}`,
      }));
      const sessionAllowed = await elicitPaths(pathInfos, allowedDirectories, "batch_edit", "edit", resolvedExcludePaths);
      const effectiveAllowed = sessionAllowed.length > 0
        ? [...allowedDirectories, ...sessionAllowed]
        : allowedDirectories;
      const approvedPaths = [...new Set([...sessionAllowedEditPaths, ...sessionAllowed])];
      const result = await handleBatchEdit(parsed, effectiveAllowed, DRY_RUN, resolvedExcludePaths, approvedPaths, (done, total) => reportProgress(extra, done, total));
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
  if (allowedExtraPaths.length > 0) parts.push(`allowed=[${allowedExtraPaths.join(', ')}]`);
  if (EXCLUDE_PATHS_RAW.length > 0) parts.push(`excluded=[${EXCLUDE_PATHS_RAW.join(', ')}]`);
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
  return [...new Set([...validRootDirectories, ...allowedExtraPaths, ...sessionPaths])];
}

async function elicitPaths(
  pathInfos: { path: string; detail: string }[],
  allowedDirs: string[],
  toolName: string,
  toolType: "read" | "edit",
  excludeDirs: string[],
): Promise<string[]> {
  const sessionList = toolType === "read" ? sessionAllowedReadPaths : sessionAllowedEditPaths;
  const unauthorized = [...new Set(
    pathInfos
      .filter(pi => isAbsolute(pi.path) && !looksLikeGlob(pi.path)
        && !isAccessible(pi.path, allowedDirs, excludeDirs, sessionList))
      .map(pi => pi.path)
  )];
  if (unauthorized.length === 0 || !server.server.getClientCapabilities()?.elicitation) return [];
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

      const excluded = excludeDirs.length > 0 && isPathAllowed(p, excludeDirs);
      const base = detail
        ? `${toolName} — ${p}  (${detail})`
        : `${toolName} — ${p}`;
      const msg = excluded ? `${base} — excluded path, approval required` : base;
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

let isShuttingDown = false;

async function shutdown(source: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    console.error(`batch-tools-mcp-server: Shutdown via ${source}`);
    await server.server.close(); 
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error shutting down batch-tools-mcp-server via ${source}: ${message}`);
  }

  process.exit(0);
}

process.stdin.on('end', () => void shutdown('stdin:end'));
process.stdin.on('close', () => void shutdown('stdin:close'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`batch-tools-mcp-server fatal: ${message}`);
  process.exit(1);
});