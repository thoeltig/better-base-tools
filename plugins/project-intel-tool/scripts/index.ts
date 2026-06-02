#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { getOrCreateSummaries, mergeSamplingResults, toAbsReal } from './lib/summary-merger.js';
import { buildFileMap } from './lib/file-map.js';
import { buildSamplingBatches, runSamplingBackground, writeBatchFiles, SamplingServer } from './lib/sampler.js';
import {
  ENV_INCLUDE_PATHS,
  ENV_EXCLUDE_PATHS,
  FORMAT_GROUPED,
  GroupedScoredFileSummary,
  HierarchicalGrouping,
  KNOWLEDGE_DIRECTORY,
  QUERY_RESULT_MAX,
  SAMPLING_TOKEN_BUDGET,
  SamplingFileSummary,
  ScanConfig,
  DEFAULT_SCAN_CONFIG,
  ROLE_VALUES,
  ScoredFileSummary,
  ToolContentResult,
} from './types.js';

const server = new McpServer(
  { 
    name: 'project-intel-mcp-server', 
    version: '1.3.1' },
  { 
    capabilities: { 
      tools: {}, 
      logging: {} 
    }
  }
);

let validRootDirectories: string[] = [];

const LOCK_FILE = 'summaries.lock';
const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

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
  maxTokensPerBatch: parseInt(parseConfigArg('max-batch-tokens', 'PROJECT_INTEL_TOOL_MAX_BATCH_TOKENS', String(SAMPLING_TOKEN_BUDGET)), 10) || SAMPLING_TOKEN_BUDGET,
  minBatchTokens: parseInt(parseConfigArg('min-batch-tokens', 'PROJECT_INTEL_TOOL_MIN_BATCH_TOKENS', String(DEFAULT_SCAN_CONFIG.minBatchTokens)), 10) || DEFAULT_SCAN_CONFIG.minBatchTokens,
  charsPerToken: parseFloat(parseConfigArg('chars-per-token', 'PROJECT_INTEL_TOOL_CHARS_PER_TOKEN', String(DEFAULT_SCAN_CONFIG.charsPerToken))) || DEFAULT_SCAN_CONFIG.charsPerToken,
  includePaths: parseConfigArg('include', ENV_INCLUDE_PATHS, '').split(',').filter(Boolean),
  excludePaths: parseConfigArg('exclude', ENV_EXCLUDE_PATHS, '').split(',').filter(Boolean),
};

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

let activeLockPath: string | null = null;

const shutdownController = new AbortController();

function isLockStale(lock: { pid: number; startedAt: string }): boolean {
  try {
    process.kill(lock.pid, 0);
    return Date.now() - new Date(lock.startedAt).getTime() > LOCK_MAX_AGE_MS;
  } catch (err: any) {
    return err.code !== 'EPERM'; // ESRCH = dead; EPERM = alive, no permission
  }
}

function acquireLock(knowledgeDir: string): boolean {
  const lockPath = path.join(knowledgeDir, LOCK_FILE);
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (!isLockStale(lock)) return false;
    } catch { /* corrupt lock — treat as stale */ }
  }
  try {
    const tmpPath = lockPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.renameSync(tmpPath, lockPath);
    activeLockPath = lockPath;
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  if (!activeLockPath) return;
  try { fs.unlinkSync(activeLockPath); } catch { /* ignore */ }
  activeLockPath = null;
}

async function acquireSubmitLock(knowledgeDir: string, timeoutMs = 30_000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (acquireLock(knowledgeDir)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function shutdown(): void {
  console.error('[server] Shutdown signal received, aborting background tasks');
  shutdownController.abort();
  releaseLock();
  process.exit(0);
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

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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

function samplerLog(level: 'info' | 'warning' | 'error', msg: string): void {
  writeMcpLogLine(level, msg, 'sampler');
}

function prepareAnalysisBatches(
  filesToScan: string[],
  knowledgeDir: string,
  projectRoot: string,
  config: ScanConfig,
): ReturnType<typeof buildSamplingBatches> {
  const existingSummaries = getOrCreateSummaries(knowledgeDir, projectRoot);
  const allProjectFiles = [...new Set([
    ...filesToScan,
    ...[...existingSummaries.files.entries()].filter(([, v]) => !v.deleted)
      .map(([abs]) => path.relative(toAbsReal(projectRoot, '.'), abs).replace(/\\/g, '/')),
  ])];
  const fileMap = buildFileMap(filesToScan, projectRoot, allProjectFiles);
  return buildSamplingBatches(filesToScan, fileMap, existingSummaries, config, projectRoot);
}

async function runFullScanBackground(
  filesToScan: string[],
  knowledgeDir: string,
  projectRoot: string,
): Promise<void> {
  try {
    const batches = prepareAnalysisBatches(filesToScan, knowledgeDir, projectRoot, scanConfig);

    await runSamplingBackground(
      batches,
      server.server as unknown as SamplingServer,
      knowledgeDir,
      projectRoot,
      shutdownController.signal,
      samplerLog
    );
  } catch (err) {
    writeMcpLogLine('error', `Background scan error: ${err instanceof Error ? err.message : String(err)}`, 'scan');
  } finally {
    isScanning = false;
    releaseLock();
  }
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
    description: 'Scan the current project directory and generate AI summaries in the background. Returns immediately with the number of files being processed. Use query after scanning.',
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
  async (args) => {
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
        runFullScanBackground(filesToScan, knowledgeDir, projectRoot)
          .catch(err => writeMcpLogLine('error', `Background scan crashed: ${err instanceof Error ? err.message : String(err)}`, 'scan'));
        writeMcpLogLine('info', `scan — launched background scan for ${filesToScan.length} file(s)`, 'scan');
        return createOutputMessage(`Structural data for ${filesToScan.length} file(s) will be available shortly. AI descriptions follow in the background. Query at any time.`);
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
          'You should run them in parallel in the foreground, so the user can handle possible permission issues. For each path in "batchFiles", spawn a subagent with a smaller, faster model (e.g. Haiku). ' +
          'Prompt for the subagent: Follow the instructions in the provided file.',
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
      inputSchema: z.object({
        results: z.array(z.object({
          path: z.string(),
          summary: z.string().optional(),
          role: z.string().optional(),
          technologies: z.array(z.string()).optional(),
          searchTags: z.array(z.string()).optional(),
          exports: z.array(z.string()).optional(),
          imports: z.array(z.string()).optional(),
        })),
      }).strict(),
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
      max: z.number().optional().describe(`Max results (default: ${QUERY_RESULT_MAX})`),
      format: z.enum(['grouped', 'flat']).optional().describe('Output format: grouped (default) or flat'),
      role: z.enum(ROLE_VALUES).optional().describe('Filter results to files with this role'),

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
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!fs.existsSync(knowledgeDir)) {
        return createOutputMessage('No knowledge found. Run scan first.', true);
      }

      const keywords = args.keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);
      const scope = args.scope;
      const maxResults = args.max || QUERY_RESULT_MAX;
      const format = args.format || FORMAT_GROUPED;

      const projectRoot = path.dirname(path.resolve(knowledgeDir));
      const primarySummaries = getOrCreateSummaries(knowledgeDir, projectRoot);
      const scored: ScoredFileSummary[] = [];

      const scoreFiles = (summaries: ReturnType<typeof getOrCreateSummaries>, pathPrefix: string, summaryProjectRoot: string) => {
        summaries.files.forEach((summary, absPath) => {
          if (summary.deleted) return;
          const relPath = path.relative(summaryProjectRoot, absPath).replace(/\\/g, '/');
          const prefixedPath = pathPrefix ? `${pathPrefix}/${relPath}`.replace(/\/\//g, '/') : relPath;
          if (scope && !prefixedPath.startsWith(scope)) return;
          if (args.role && summary.role !== args.role) return;
          const score = calculateConfidence(keywords, prefixedPath, summary);
          if (score > 0) {
            const { lastUpdated: _ld, ...summaryRest } = summary;
            scored.push({ fileScore: score, path: prefixedPath, ...summaryRest });
          }
        });
      };

      scoreFiles(primarySummaries, '', projectRoot);

      for (const ref of primarySummaries.subKnowledge) {
        const subDir = path.resolve(projectRoot, ref.knowledgeDir);
        if (fs.existsSync(subDir)) {
          const subProjectRoot = path.dirname(path.resolve(subDir));
          const subSummaries = getOrCreateSummaries(subDir, subProjectRoot);
          scoreFiles(subSummaries, ref.location, subProjectRoot);
        }
      }

      scored.sort((a, b) => b.fileScore - a.fileScore);
      const limited = scored.slice(0, maxResults);

      let output: unknown;
      if (format === FORMAT_GROUPED) {
        const grouped: Record<string, HierarchicalGrouping> = {};
        limited.forEach(item => {
          const folderPath = path.dirname(item.path).replace(/\\/g, '/') || '.';
          if (!grouped[folderPath]) {
            grouped[folderPath] = { folderPath, folderScore: 0, files: [] };
          }
          const group = grouped[folderPath]!;
          group.folderScore += item.fileScore;
          if (item.technologies?.length) {
            const set = new Set(group.technologies ?? []);
            item.technologies.forEach(t => set.add(t));
            group.technologies = [...set];
          }
          const fileName = path.basename(item.path);
          const { path: _p, technologies: _t, lastUpdated: _ld, deleted: _del, sizeCharsWhenAnalysed: _sca, lineCountWhenAnalysed: _lcwa, fileScore: _score, searchTags: _stags, ...restFields } = item;
          const f: GroupedScoredFileSummary = { fileName, ...restFields };
          group.files.push(f);
        });
        output = {
          total: limited.length,
          grouped: Object.values(grouped)
            .sort((a, b) => b.folderScore - a.folderScore)
            .map(({ folderScore: _fs, ...rest }) => rest),
        };
      } else {
        output = {
          total: limited.length,
          results: limited.map(({ deleted: _del, lastUpdated: _ld, sizeCharsWhenAnalysed: _sca, lineCountWhenAnalysed: _lcwa, fileScore: _score, searchTags: _stags, ...rest }) => rest),
        };
      }

      writeMcpLogLine('info', `query done — ${limited.length} result(s)`, 'query');
      const queryResult: CallToolResult = { 
        content: [{ 
          type: 'text', 
          text: JSON.stringify(output), 
          annotations: { 
            audience: ['assistant'], 
            priority: 0.3,
            lastModified: new Date().toISOString()
          }
        }]
      };
      if (USE_USER_AUDIENCE) queryResult.content.push({
        type: 'text',
        text: `Found ${limited.length} knowledge entr${limited.length === 1 ? 'y' : 'ies'}`,
        annotations: { 
          audience: ['user'], 
          priority: 0
        }
      });
      if (USE_STRUCTURED_CONTENT) queryResult.structuredContent = output as Record<string, unknown>;
      return queryResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine('error', `query error — ${message}`, 'query');
      return createOutputMessage(message, true);
    }
  }
);

function calculateConfidence(keywords: string[], itemPath: string, summary: any): number {
  let score = 0;
  const pathLower = itemPath.toLowerCase();
  const sumLower = (summary.summary || '').toLowerCase();
  const baseline = summary.sizeCharsWhenAnalysed;
  const current = summary.sizeChars;
  const semanticWeight = (baseline && current)
    ? Math.min(baseline, current) / Math.max(baseline, current)
    : 1;
  keywords.forEach(k => {
    if (sumLower.includes(k)) score += 6 * semanticWeight;
    if (summary.searchTags?.some((t: string) => t.toLowerCase().includes(k))) score += 3 * semanticWeight;
    if (summary.exports?.some((e: string) => e.toLowerCase().includes(k))) score += 4;
    if (summary.imports?.some((i: string) => i.toLowerCase().includes(k))) score += 4;
    if (summary.refs?.some((r: string) => r.toLowerCase().includes(k))) score += 3;
    if (pathLower.includes(k)) score += 4;
    if (summary.technologies?.some((t: string) => t.toLowerCase().includes(k))) score += 2 * semanticWeight;
    if (summary.role?.toLowerCase().includes(k)) score += 2 * semanticWeight;
  });
  return score;
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`project-intel-mcp-server fatal: ${message}`);
  process.exit(1);
});
