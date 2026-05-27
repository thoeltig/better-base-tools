#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { getOrCreateSummaries, mergeSamplingResults } from './lib/summary-merger.js';
import { buildFileMap } from './lib/file-map.js';
import { buildSamplingBatches, runSamplingBackground, SamplingServer } from './lib/sampler.js';
import {
  FORMAT_GROUPED,
  GroupedScoredFileSummary,
  HierarchicalGrouping,
  KNOWLEDGE_DIRECTORY,
  QUERY_RESULT_MAX,
  SamplingFileSummary,
  ScoredFileSummary,
} from './types.js';

// TODO: scanProject already loads summaries internally; returning them would avoid the second getOrCreateSummaries call.

const server = new McpServer(
  { name: 'project-intel-mcp-server', version: '2.0.0' },
  { capabilities: { tools: {}, logging: {} } }
);

let validRootDirectories: string[] = [];

const shutdownController = new AbortController();

function shutdown(): void {
  console.error('[server] Shutdown signal received, aborting background tasks');
  shutdownController.abort();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function writeMcpLogLine(level: LoggingLevel, data: string, logger?: string): void {
  try {
    server.sendLoggingMessage({ level, data, logger });
  } catch { /* ignore if client doesn't support logging */ }
}

function samplerLog(level: 'info' | 'warning' | 'error', msg: string): void {
  writeMcpLogLine(level, msg, 'sampler');
}

async function runFullScanBackground(
  filesToScan: string[],
  knowledgeDir: string,
  projectRoot: string,
): Promise<void> {
  try {
    const fileMap = buildFileMap(filesToScan, projectRoot);

    // Pre-populate structural data so query works before AI descriptions arrive
    const structuralEntries: SamplingFileSummary[] = filesToScan.map(filePath => {
      const fm = fileMap.get(filePath) ?? { imports: [], exports: [], refs: [], sizeChars: 0, lineCount: 0 };
      const entry: SamplingFileSummary = { path: filePath, sizeChars: fm.sizeChars, lineCount: fm.lineCount };
      if (fm.exports.length > 0) entry.exports = fm.exports;
      if (fm.imports.length > 0) entry.imports = fm.imports;
      if (fm.refs.length > 0) entry.refs = fm.refs;
      return entry;
    });
    mergeSamplingResults(knowledgeDir, structuralEntries);
    writeMcpLogLine('info', `Pre-populated ${filesToScan.length} file(s) with structural data`, 'scan');

    const summaries = getOrCreateSummaries(knowledgeDir);
    const batches = buildSamplingBatches(filesToScan, fileMap, summaries);

    await runSamplingBackground(
      batches,
      server.server as unknown as SamplingServer,
      knowledgeDir,
      projectRoot,
      shutdownController.signal,
      fileMap,
      samplerLog
    );
  } catch (err) {
    writeMcpLogLine('error', `Background scan error: ${err instanceof Error ? err.message : String(err)}`, 'scan');
  }
}

async function updateValidRootDirectories(): Promise<void> {
  try {
    const response = await server.server.listRoots();
    if (response?.roots) {
      validRootDirectories = response.roots
        .map(r => r.uri.replace('file://', ''))
        .filter(Boolean);
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
    const root = assertRoots();
    if (!root) {
      return { isError: true, content: [{ type: 'text', text: 'No MCP roots available. Cannot determine project location.' }] };
    }
    try {
      const knowledgeDir = findKnowledgeDir(root) || path.join(root, KNOWLEDGE_DIRECTORY);

      if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });

      const projectRoot = path.dirname(path.resolve(knowledgeDir));
      const scanLocation = args.scanLocation ? path.resolve(root, args.scanLocation) : root;
      if (!scanLocation.startsWith(root)) {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeMcpLogLine('error', `scan error — ${message}`, 'scan');
      return { isError: true, content: [{ type: 'text', text: `scan error: ${message}` }] };
    }
  }
);

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
