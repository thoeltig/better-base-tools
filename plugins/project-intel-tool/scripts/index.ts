#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { getOrCreateSummaries, mergeSamplingResults } from './lib/summary-merger.js';
import { buildFileMap } from './lib/file-map.js';
import { buildSamplingBatches, runSamplingBackground, writeBatchFiles, SamplingServer } from './lib/sampler.js';
import {
  FORMAT_GROUPED,
  GroupedScoredFileSummary,
  HierarchicalGrouping,
  KNOWLEDGE_DIRECTORY,
  QUERY_RESULT_MAX,
  SamplingFileSummary,
  ScoredFileSummary,
} from './types.js';

const server = new McpServer(
  { name: 'project-intel-mcp-server', version: '2.0.0' },
  { capabilities: { tools: {}, logging: {} } }
);

let validRootDirectories: string[] = [];

const LOCK_FILE = 'summaries.lock';
const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

let isScanning = false;

// MCP harnesses like Claude Code do not support sampling or logging via the MCP protocol.
// Sampling is replaced by a subagent workaround and logging falls back to console.error for errors only.
// Both are disabled by default so the server works out of the box in any harness.
// Enable only when the harness is known to support the respective MCP capability.
const USE_MCP_SAMPLING = process.env['MCP_SAMPLING'] === 'true' || process.argv.includes('--mcp-sampling');
const USE_MCP_LOGGING = process.env['MCP_LOGGING'] === 'true' || process.argv.includes('--mcp-logging');
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

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function writeMcpLogLine(level: LoggingLevel, data: string, logger?: string): void {
  if (USE_MCP_LOGGING) {
    try {
      server.sendLoggingMessage({ level, data, logger });
    } catch { /* ignore if client doesn't support logging */ }
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
): ReturnType<typeof buildSamplingBatches> {
  const fileMap = buildFileMap(filesToScan, projectRoot);
  const structuralEntries: SamplingFileSummary[] = filesToScan.map(filePath => {
    const fm = fileMap.get(filePath) ?? { imports: [], exports: [], refs: [], sizeChars: 0, lineCount: 0 };
    const entry: SamplingFileSummary = { path: filePath, sizeChars: fm.sizeChars, lineCount: fm.lineCount };
    if (fm.exports.length > 0) entry.exports = fm.exports;
    if (fm.imports.length > 0) entry.imports = fm.imports;
    if (fm.refs.length > 0) entry.refs = fm.refs;
    return entry;
  });
  const summaries = mergeSamplingResults(knowledgeDir, structuralEntries);
  writeMcpLogLine('info', `Pre-populated ${filesToScan.length} file(s) with structural data`, 'scan');
  return buildSamplingBatches(filesToScan, fileMap, summaries);
}

async function runFullScanBackground(
  filesToScan: string[],
  knowledgeDir: string,
  projectRoot: string,
): Promise<void> {
  try {
    const batches = prepareAnalysisBatches(filesToScan, knowledgeDir, projectRoot);

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
    writeMcpLogLine('warning', `Failed to fetch roots: ${err instanceof Error ? err.message : String(err)}`, 'roots');
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
    writeMcpLogLine('warning', 'All roots removed. Tools will fail until roots are restored.', 'roots');
  } else {
    writeMcpLogLine('info', `Roots updated: ${validRootDirectories[0]}`, 'roots');
  }
});

function safeRealpathSync(p: string): string {
  try { return fs.realpathSync(path.resolve(p)); }
  catch { return path.resolve(p); }
}

function assertRoots(): string | null {
  if (validRootDirectories.length === 0) return null;
  return validRootDirectories[0]!;
}

// --- Tools ---

server.registerTool(
  'scan',
  {
    title: 'Scan project and generate AI file summaries',
    description:
      'Scan the current project directory and generate AI summaries in the background. ' +
      'Returns immediately with the number of files being processed. Use query after scanning.',
    inputSchema: z.object({
      scanLocation: z.string().optional().describe(
        'Sub-folder to scan relative to the project root. Default: entire project.'
      ),
    }).strict(),
    annotations: {
      title: 'Scan project and generate AI file summaries',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    writeMcpLogLine('info', `scan — called${args.scanLocation ? ` (scope: ${args.scanLocation})` : ''}`, 'scan');
    if (isScanning) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'scanning', message: 'A scan is already in progress.' }) }] };
    }
    const root = assertRoots();
    if (!root) {
      return { isError: true, content: [{ type: 'text', text: 'No MCP roots available. Cannot determine project location.' }] };
    }
    try {
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });

      const projectRoot = path.dirname(path.resolve(knowledgeDir));
      const scanLocation = args.scanLocation ? path.resolve(root, args.scanLocation) : root;
      if (!safeRealpathSync(scanLocation).startsWith(safeRealpathSync(root))) {
        return { isError: true, content: [{ type: 'text', text: `scanLocation must be within the project root: ${root}` }] };
      }
      const scanResult = await scanProject(scanLocation, knowledgeDir);
      const { filesToScan } = scanResult;

      if (filesToScan.length === 0) {
        writeMcpLogLine('info', 'scan — up_to_date', 'scan');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'up_to_date',
              totalFiles: scanResult.projectStats.totalFilesInKnowledge,
              message: 'All files are up to date. Use query to search.',
            }),
          }],
        };
      }

      if (USE_MCP_SAMPLING) {
        if (!acquireLock(knowledgeDir)) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'scanning', message: 'A scan is already in progress for this project.' }) }] };
        }
        isScanning = true;
        runFullScanBackground(filesToScan, knowledgeDir, projectRoot)
          .catch(err => writeMcpLogLine('error', `Background scan crashed: ${err instanceof Error ? err.message : String(err)}`, 'scan'));
        writeMcpLogLine('info', `scan — launched background scan for ${filesToScan.length} file(s)`, 'scan');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'scanning',
              filesToScan: filesToScan.length,
              message: `Structural data for ${filesToScan.length} file(s) will be available shortly. AI descriptions follow in the background. Query at any time.`,
            }),
          }],
        };
      }

      // Subagent mode: pre-populate structural data, write batch task files, return for main model orchestration
      const batches = prepareAnalysisBatches(filesToScan, knowledgeDir, projectRoot);
      const batchFiles = writeBatchFiles(batches, knowledgeDir, projectRoot);
      writeMcpLogLine('info', `scan — wrote ${batches.length} batch file(s) for subagent analysis`, 'scan');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'analysis_required',
            batchCount: batches.length,
            batchFiles,
            instruction:
              `Spawn ${batches.length} subagent(s). For each path in "batchFiles", spawn a subagent with a smaller, faster model (e.g. Haiku). ` +
              'Subagent task: read the file — it contains the full analysis prompt with embedded file contents and instructions. Follow the instructions in it. ' +
              'Return a short completion message when done.',
          }),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine('error', `scan error — ${message}`, 'scan');
      return { isError: true, content: [{ type: 'text', text: `scan error: ${message}` }] };
    }
  }
);

if (!USE_MCP_SAMPLING) {
  server.registerTool(
    'submit_analysis',
    {
      title: 'Submit file analysis results from subagent',
      description:
        'Called by analysis subagents to submit file summaries into project knowledge. ' +
        'Serializes concurrent writes — multiple subagents can safely call this in parallel.',
      inputSchema: z.object({
        results: z.array(z.object({
          path: z.string(),
          summary: z.string().optional(),
          purpose: z.string().optional(),
          role: z.string().optional(),
          technologies: z.array(z.string()).optional(),
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
      _meta:{
        "anthropic/maxResultSizeChars": 500000
      },
    },
    async (args) => {
      writeMcpLogLine('info', `submit_analysis — ${args.results.length} file(s) queued`, 'submit');
      const root = assertRoots();
      if (!root) {
        return { isError: true, content: [{ type: 'text', text: 'No MCP roots available.' }] };
      }
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!await acquireSubmitLock(knowledgeDir)) {
        return { isError: true, content: [{ type: 'text', text: 'submit_analysis: timed out waiting for write lock' }] };
      }
      try {
        mergeSamplingResults(knowledgeDir, args.results as SamplingFileSummary[]);
        writeMcpLogLine('info', `submit_analysis — merged ${args.results.length} file(s)`, 'submit');
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'success', filesProcessed: args.results.length }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeMcpLogLine('error', `submit_analysis error — ${message}`, 'submit');
        return { isError: true, content: [{ type: 'text', text: `submit_analysis error: ${message}` }] };
      } finally {
        releaseLock();
      }
    }
  );
}

server.registerTool(
  'query',
  {
    title: 'Search project file summaries by keywords',
    description:
      'Search project file summaries by keywords. Searches primary knowledge and any sub-project knowledge. ' +
      'Returns ranked results. Deleted files are excluded.',
    inputSchema: z.object({
      keywords: z.string().describe('Space-separated search terms'),
      scope: z.string().optional().describe('Limit results to files under this directory path'),
      max: z.number().optional().describe(`Max results (default: ${QUERY_RESULT_MAX})`),
      format: z.string().optional().describe('Output format: grouped (default) or flat'),
    }).strict(),
    annotations: {
      title: 'Search project file summaries by keywords',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) => {
    writeMcpLogLine('info', `query — keywords: "${args.keywords}"`, 'query');
    const root = assertRoots();
    if (!root) {
      return { isError: true, content: [{ type: 'text', text: 'No MCP roots available. Cannot determine project location.' }] };
    }
    try {
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!fs.existsSync(knowledgeDir)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No knowledge found. Run scan first.' }) }],
        };
      }

      const keywords = args.keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);
      const scope = args.scope || '';
      const maxResults = args.max || QUERY_RESULT_MAX;
      const format = args.format || FORMAT_GROUPED;

      const primarySummaries = getOrCreateSummaries(knowledgeDir);
      const scored: ScoredFileSummary[] = [];

      const scoreFiles = (summaries: ReturnType<typeof getOrCreateSummaries>, pathPrefix: string) => {
        summaries.files.forEach((summary, filePath) => {
          if (summary.deleted) return;
          const prefixedPath = pathPrefix ? `${pathPrefix}/${filePath}`.replace(/\/\//g, '/') : filePath;
          if (scope && !prefixedPath.startsWith(scope)) return;
          const score = calculateConfidence(keywords, prefixedPath, summary);
          if (score > 0) {
            const { lastUpdated: _ld, ...summaryRest } = summary;
            scored.push({ fileScore: score, path: prefixedPath, ...summaryRest });
          }
        });
      };

      scoreFiles(primarySummaries, '');

      for (const ref of primarySummaries.subKnowledge) {
        const subDir = path.resolve(path.dirname(path.resolve(knowledgeDir)), ref.knowledgeDir);
        if (fs.existsSync(subDir)) {
          const subSummaries = getOrCreateSummaries(subDir);
          scoreFiles(subSummaries, ref.location);
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
          const fileName = path.basename(item.path);
          const { path: _p, technologies: _t, lastUpdated: _ld, ...restFields } = item;
          const f: GroupedScoredFileSummary = { fileName, ...restFields };
          group.files.push(f);
        });
        output = {
          query: args.keywords,
          keywords,
          scope: scope || 'all',
          total: limited.length,
          grouped: Object.values(grouped).sort((a, b) => b.folderScore - a.folderScore),
        };
      } else {
        output = {
          query: args.keywords,
          keywords,
          scope: scope || 'all',
          total: limited.length,
          results: limited,
        };
      }

      writeMcpLogLine('info', `query done — ${limited.length} result(s)`, 'query');
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine('error', `query error — ${message}`, 'query');
      return { isError: true, content: [{ type: 'text', text: `query error: ${message}` }] };
    }
  }
);

function calculateConfidence(keywords: string[], itemPath: string, summary: any): number {
  let score = 0;
  const pathLower = itemPath.toLowerCase();
  const sumLower = (summary.summary || '').toLowerCase();
  const purposeLower = (summary.purpose || '').toLowerCase();
  keywords.forEach(k => {
    if (purposeLower.includes(k)) score += 6;
    if (sumLower.includes(k)) score += 6;
    if (summary.exports?.some((e: string) => e.toLowerCase().includes(k))) score += 4;
    if (summary.imports?.some((i: string) => i.toLowerCase().includes(k))) score += 4;
    if (summary.refs?.some((r: string) => r.toLowerCase().includes(k))) score += 3;
    if (pathLower.includes(k)) score += 4;
    if (summary.technologies?.some((t: string) => t.toLowerCase().includes(k))) score += 2;
    if (summary.role?.toLowerCase().includes(k)) score += 2;
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
