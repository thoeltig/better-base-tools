#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LoggingLevel, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir, discoverSubKnowledge } from './lib/project-scanner.js';
import { mergeSamplingResults, toAbsReal } from './lib/summary-merger.js';
import { runSampling, writeBatchFiles } from './lib/sampler.js';
import {
  ENV_MAX_BATCH_TOKENS,
  ENV_CHARS_PER_TOKEN,
  FORMAT_GROUPED,
  KNOWLEDGE_DIRECTORY,
  QUERY_RESULT_MAX,
  SAMPLING_TOKEN_BUDGET,
  SamplingFileSummary,
  ScanConfig,
  DEFAULT_SCAN_CONFIG,
  ROLE_VALUES,
  ScoredFileSummary,
  SubKnowledgeRef,
  ToolContentResult,
  VERBOSITY_VALUES,
  VerbosityType,
  FORMAT_VALUES,
  FluentOutput,
  AnalysisSubmission,
} from './types.js';
import { generateQueryOutput, outputToFluentText, query } from './lib/query-engine.js';
import { prepareAnalysisBatches } from './lib/analysis-batch.js';
import { acquireLock, acquireSubmitLock, releaseLock } from './lib/lock.js';
import { getExcludePaths, getIncludePaths, parseConfigArg, parseConfigArgRecord } from './lib/config.js';

const server = new McpServer(
  { 
    name: 'project-intel-mcp-server', 
    version: '1.4.9' 
  },
  { 
    capabilities: { 
      tools: {}, 
      logging: {} 
    }
  }
);

let validRootDirectories: string[] = [];
let isScanning = false;

// MCP harnesses like Claude Code do not support sampling or logging via the MCP protocol.
// Sampling is replaced by a subagent workaround and logging falls back to console.error for errors only.
// Both are disabled by default so the server works out of the box in any harness.
// Enable only when the harness is known to support the respective MCP capability.
const USE_MCP_SAMPLING = parseConfigArg('mcp-sampling', 'PROJECT_INTEL_TOOL_MCP_SAMPLING', 'false') === 'true';
const USE_MCP_LOGGING = parseConfigArg('mcp-logging', 'PROJECT_INTEL_TOOL_MCP_LOGGING', 'false') === 'true';
const USE_USER_AUDIENCE = parseConfigArg('user-audience', 'PROJECT_INTEL_TOOL_MCP_ANNOTATIONS_USER_AUDIENCE', 'false') === 'true';
const USE_STRUCTURED_CONTENT = parseConfigArg('mcp-structured-content', 'PROJECT_INTEL_TOOL_MCP_STRUCTURED_CONTENT', 'false') === 'true';
const SCAN_META = parseConfigArgRecord('scan-meta', 'PROJECT_INTEL_TOOL_SCAN_META');
const QUERY_META = parseConfigArgRecord('query-meta', 'PROJECT_INTEL_TOOL_QUERY_META');
const SUBMIT_ANALYSIS_META = parseConfigArgRecord('submit-analysis-meta', 'PROJECT_INTEL_TOOL_SUBMIT_ANALYSIS_META');

const scanConfig: ScanConfig = {
  maxTokensPerBatch: parseInt(parseConfigArg('max-batch-tokens', ENV_MAX_BATCH_TOKENS, String(SAMPLING_TOKEN_BUDGET)), 10) || SAMPLING_TOKEN_BUDGET,
  charsPerToken: parseFloat(parseConfigArg('chars-per-token', ENV_CHARS_PER_TOKEN, String(DEFAULT_SCAN_CONFIG.charsPerToken))) || DEFAULT_SCAN_CONFIG.charsPerToken,
  includePaths: getIncludePaths(),
  excludePaths: getExcludePaths(),
};

const shutdownController = new AbortController();
let isShuttingDown = false;

async function shutdown(source: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    console.error(`project-intel-mcp-server: Release resources`);
    shutdownController.abort();
    releaseLock();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error releasing resources from project-intel-mcp-server: ${message}`);
  }
  
  try {
    console.error(`project-intel-mcp-server: Shutdown via ${source}`);
    await server.server.close(); 
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error shutting down project-intel-mcp-server via ${source}: ${message}`);
  }

  process.exit(0);
}

process.stdin.on('end', () => void shutdown('stdin:end'));
process.stdin.on('close', () => void shutdown('stdin:close'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

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
      method: 'notifications/progress',
      params: { 
        progressToken: token,
        progress,
        total,
        message
      },
    });
  } catch { /* ignore if client doesn't support progress */ }
}

async function updateValidRootDirectories(): Promise<void> {
  try {
    const response = await server.server.listRoots();
    if (response?.roots) {
      validRootDirectories = response.roots
        .map(r => {
          try {
            const p = r.uri.startsWith('file://') ? fileURLToPath(r.uri) : r.uri;
            return path.resolve(p);
          } catch { return null; }
        })
        .filter((p): p is string => p !== null && p.length > 0);
    }
  } catch (err) {
    writeMcpLogLine('warning', `Failed to fetch roots: ${err instanceof Error ? err.message : String(err)}`, 'permissions');
  }
}

server.server.oninitialized = async () => {
  const caps = server.server.getClientCapabilities();
  if (!caps?.roots) {
    writeMcpLogLine('error', 'Client does not support roots capability. Cannot determine project location.', 'server');
    process.exit(1);
  }
  await updateValidRootDirectories();
  if (validRootDirectories.length === 0) {
    writeMcpLogLine('error', 'No roots returned by client. Cannot determine project location.', 'server');
    process.exit(1);
  }
  writeMcpLogLine('info', `Project root: ${validRootDirectories[0]}`, 'server');
};

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  await updateValidRootDirectories();
  if (validRootDirectories.length === 0) {
    writeMcpLogLine('warning', 'All roots removed. Tools will fail until roots are restored.', 'permissions');
  } else {
    writeMcpLogLine('info', `Roots updated: ${validRootDirectories[0]}`, 'permissions');
  }
});

function assertRoots(): string | null {
  if (validRootDirectories.length === 0) return null;
  return validRootDirectories[0]!;
}

// --- Tools ---

server.registerTool(
  'scan',
  {
    title: 'Scan project and generate AI file summaries',
    description: 'Scan the current project directory and generate AI summaries. Blocks until complete. Use query after scanning.',
    inputSchema: z.object({
      scanLocation: z.string().optional()
        .describe('Sub-folder to scan relative to the project root. Default: entire project.'),
    }).strict(),
    annotations: {
      title: 'Scan project and generate AI file summaries',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: SCAN_META,
  },
  async (args, extra) => {
    writeMcpLogLine('info', `scan — called${args.scanLocation ? ` (scope: ${args.scanLocation})` : ''}`, 'scan');
    if (isScanning) {
      return createOutputMessage('A scan is already in progress.');
    }
    const root = assertRoots();
    if (!root) {
      return createOutputMessage('No MCP roots available. Cannot determine project location.', true);
    }
    try {
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });

      const projectRoot = path.dirname(path.resolve(knowledgeDir));
      const scanLocation = args.scanLocation ? path.resolve(root, args.scanLocation) : root;
      if (!toAbsReal(scanLocation, '.').startsWith(toAbsReal(root, '.'))) {
        return createOutputMessage(`scanLocation must be within the project root: ${root}`, true);
      }
      const scanResult = await scanProject(scanLocation, knowledgeDir, scanConfig);
      const { filesToScan } = scanResult;

      if (filesToScan.length === 0) {
        writeMcpLogLine('info', 'scan — up_to_date', 'scan');
        return createOutputMessage('All files are up to date. Use query to search.');
      }

      if (USE_MCP_SAMPLING) {
        if (!acquireLock(knowledgeDir)) {
          return createOutputMessage('A scan is already in progress for this project.');
        }
        isScanning = true;
        const samplerLog = (level: LoggingLevel, msg: string,) => writeMcpLogLine(level, msg, 'sampler');
        const onProgress = (done: number, total: number, msg: string) => reportProgress(extra, done, total, msg);
        try {
          const batches = prepareAnalysisBatches(filesToScan, knowledgeDir, projectRoot, scanConfig);
          await runSampling(
            batches,
            server,
            knowledgeDir,
            projectRoot,
            shutdownController.signal,
            samplerLog,
            onProgress
          );
          writeMcpLogLine('info', `scan complete — ${filesToScan.length} file(s) in ${batches.length} batch(es)`, 'scan');
          return createOutputMessage(`Scan complete. Analysed ${filesToScan.length} file(s) in ${batches.length} batch(es). Use query to search.`);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          writeMcpLogLine('error', `scan error — ${message}`, 'scan');
          return createOutputMessage(message, true);
        } finally {
          isScanning = false;
          releaseLock();
        }
      }

      // Subagent mode: pre-populate structural data, write batch task files, return for main model orchestration
      const batches = prepareAnalysisBatches(filesToScan, knowledgeDir, projectRoot, scanConfig);
      const batchFiles = writeBatchFiles(batches, knowledgeDir, projectRoot);
      writeMcpLogLine('info', `scan — wrote ${batches.length} batch file(s) for subagent analysis`, 'scan');
      const analysisInstructions = {
        status: 'analysis_required',
        batchCount: batches.length,
        batchFiles,
        instruction:
          `You need to spawn ${batches.length} subagent(s) in total, to not exhaust the current environment only run 5-10 subagents in parallel at the same time. Ask the user first if this setup is good before proceeding. ` +
          'You should run them in parallel in the foreground, so the user can handle possible permission issues. For each path in "batchFiles", spawn one subagent with subagent_type "project-intel-analyst", which already carries the fast model, necessary tool access and analysis instructions. ' +
          'Prompt for the subagent: Analyse the batch file at <path>.',
      };
      const scanToolResult: CallToolResult = {
        content: [{
          type: 'text',
          text: JSON.stringify(analysisInstructions), 
          annotations: { 
            audience: ['assistant'], 
            priority: 0.1
          }
        }],
      };
      if (USE_USER_AUDIENCE) scanToolResult.content.push({
        type: 'text',
        text: `File analysis by ${batches.length} subagents required`,
        annotations: { 
          audience: ['user'], 
          priority: 0
        }
      });
      if (USE_STRUCTURED_CONTENT) scanToolResult.structuredContent = analysisInstructions;
      return scanToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine('error', `scan error — ${message}`, 'scan');
      return createOutputMessage(message, true);
    }
  }
);

if (!USE_MCP_SAMPLING) {
  server.registerTool(
    'submit_analysis',
    {
      title: 'Submit file analysis results from subagent',
      description: 'Called by analysis subagents to submit file summaries into project knowledge. Serializes concurrent writes — multiple subagents can safely call this in parallel.',
      inputSchema: AnalysisSubmission,
      annotations: {
        title: 'Submit file analysis results from subagent',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: SUBMIT_ANALYSIS_META,
    },
    async (args) => {
      writeMcpLogLine('info', `submit_analysis — ${args.results.length} file(s) queued`, 'submit');
      const root = assertRoots();
      if (!root) {
        return createOutputMessage('No MCP roots available. Cannot determine project location.', true);
      }
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!await acquireSubmitLock(knowledgeDir)) {
        return createOutputMessage('Wait for write timed out, try again in 10s', true);
      }
      try {
        const projectRoot = path.dirname(path.resolve(knowledgeDir));
        mergeSamplingResults(knowledgeDir, args.results as SamplingFileSummary[], projectRoot);
        writeMcpLogLine('info', `submit_analysis — merged ${args.results.length} file(s)`, 'submit');
        return createOutputMessage(`Analysis for ${args.results.length} files submitted successfully`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeMcpLogLine('error', `submit_analysis error — ${message}`, 'submit');
        return createOutputMessage(message, true);
      } finally {
        releaseLock();
      }
    }
  );
}

server.registerTool(
  'query',
  {
    title: 'Query project files by path, structure, or semantics',
    description: 'Search project files by keywords matched against: file path, exports, imports, refs, searchTags, technologies, role, and semantic summary. Available immediately on session start without scanning — structural data (imports, exports, refs, lines, chars) is always current; semantic fields are confidence-weighted by changeDelta (size ratio since last scan) so stale summaries rank lower automatically. Accepts file names, folder paths, and semantic terms as keywords. Use scope to narrow to a subdirectory, role to filter by file type.',
    inputSchema: z.object({
      keywords: z.string().describe('Space-separated search terms'),
      scope: z.string().optional().describe('Limit results to files under this directory path'),
      max: z.number().optional().default(QUERY_RESULT_MAX).describe(`Max results (default: ${QUERY_RESULT_MAX})`),
      format: z.enum(FORMAT_VALUES).optional().default(FORMAT_GROUPED).describe('Output format: grouped (default) or flat'),
      role: z.enum(ROLE_VALUES).optional().describe('Filter results to files with this role'),
      verbosity: z.enum(VERBOSITY_VALUES).optional().default("full").describe('Data density: full (default) = all fields; structure = filepath/size/lines/imports/exports/refs; semantic = filepath/role/summary/technologies'),
    }).strict(),
    annotations: {
      title: 'Query project files by path, structure, or semantics',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: QUERY_META,
  },
  async (args) => {
    writeMcpLogLine('info', `query — keywords: "${args.keywords}"`, 'query');
    const root = assertRoots();
    if (!root) {
      return createOutputMessage('No MCP roots available. Cannot determine project location.', true);
    }
    try {
      const foundKnowledgeDir = findKnowledgeDir(root);
      const knowledgeDir = foundKnowledgeDir || path.join(root, KNOWLEDGE_DIRECTORY);
      let subKnowledgeOverride: SubKnowledgeRef[] | undefined;

      if (!foundKnowledgeDir) {
        subKnowledgeOverride = discoverSubKnowledge(root, root);
        if (subKnowledgeOverride.length === 0) {
          return createOutputMessage('No knowledge found. Run scan first.', true);
        }
      }

      const keywords = args.keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);
      const scope = args.scope;
      const maxResults = args.max || QUERY_RESULT_MAX;
      const format = args.format || FORMAT_GROUPED;
      const verbosity: VerbosityType = args.verbosity ?? 'full';

      const scoredFiles: ScoredFileSummary[] = query(knowledgeDir, keywords, scope, maxResults, args.role, subKnowledgeOverride);
      const output: FluentOutput = generateQueryOutput(scoredFiles, format, verbosity);
      writeMcpLogLine('info', `query done — ${scoredFiles.length} result(s)`, 'query');

      const queryResult: CallToolResult = { 
        content: [{ 
          type: 'text', 
          text: outputToFluentText(output, verbosity), 
          annotations: { 
            audience: ['assistant'], 
            priority: 0.3,
            lastModified: new Date().toISOString()
          }
        }]
      };
      if (USE_USER_AUDIENCE)  {
          queryResult.content.push({
          type: 'text',
          text: `Found ${scoredFiles.length} knowledge entr${scoredFiles.length === 1 ? 'y' : 'ies'}`,
          annotations: { 
            audience: ['user'], 
            priority: 0
          }
        });
      }
      if (USE_STRUCTURED_CONTENT) queryResult.structuredContent = output as Record<string, unknown>;
      return queryResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine('error', `query error — ${message}`, 'query');
      return createOutputMessage(message, true);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`project-intel-mcp-server fatal: ${message}`);
  process.exit(1);
});
