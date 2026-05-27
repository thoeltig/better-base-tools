#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { getOrCreateSummaries } from './lib/summary-merger.js';
import { buildFileMap } from './lib/file-map.js';
import { buildSamplingBatches, runSamplingBackground, SamplingServer } from './lib/sampler.js';
import {
  FORMAT_GROUPED,
  GroupedScoredFileSummary,
  HierarchicalGrouping,
  KNOWLEDGE_DIRECTORY,
  QUERY_RESULT_MAX,
  ScoredFileSummary,
} from './types.js';
// TODO: scanProject already loads summaries internally; consider returning them to
// avoid the second getOrCreateSummaries call in handleScan.

const server = new Server(
  { name: 'project-intel-mcp-server', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

const shutdownController = new AbortController();
function shutdown(): void {
  console.error('[server] Shutdown signal received, aborting background tasks');
  shutdownController.abort();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan',
      description:
        'Scan the current project directory and generate AI summaries in the background. ' +
        'Returns immediately with the number of files being processed. Use query after scanning.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          location: {
            type: 'string',
            description: 'Sub-directory to scan (default: current working directory). Must be inside the project root.',
          },
        },
      },
    },
    {
      name: 'query',
      description:
        'Search project file summaries by keywords. Searches primary knowledge and any sub-project knowledge. ' +
        'Returns ranked results. Deleted files are excluded.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          keywords: { type: 'string', description: 'Space-separated search terms' },
          scope: { type: 'string', description: 'Limit results to files under this directory path' },
          max: { type: 'number', description: `Max results (default: ${QUERY_RESULT_MAX})` },
          format: { type: 'string', enum: ['grouped', 'flat'], description: 'Output format (default: grouped)' },
        },
        required: ['keywords'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'scan') return handleScan((args || {}) as { location?: string });
  if (name === 'query') return handleQuery((args || {}) as { keywords: string; scope?: string; max?: number; format?: string });
  throw new Error(`Unknown tool: ${name}`);
});

async function handleScan(args: { location?: string }) {
  const cwd = process.cwd();
  const location = path.resolve(args.location || cwd);
  const knowledgeDir = findKnowledgeDir(location) || path.join(cwd, KNOWLEDGE_DIRECTORY);

  if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });

  const projectRoot = path.dirname(path.resolve(knowledgeDir));
  const scanResult = await scanProject(location, knowledgeDir);
  const { filesToScan } = scanResult;

  if (filesToScan.length === 0) {
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

  const summaries = getOrCreateSummaries(knowledgeDir);
  const fileMap = buildFileMap(filesToScan, projectRoot);
  const batches = buildSamplingBatches(filesToScan, fileMap, summaries);

  // Fire-and-forget: background sampling does not block the tool response
  runSamplingBackground(batches, server as unknown as SamplingServer, knowledgeDir, projectRoot, shutdownController.signal, fileMap)
    .catch(err => console.error('[server] Background sampling error:', err));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'scanning',
        filesToScan: filesToScan.length,
        batches: batches.length,
        message: `Processing ${filesToScan.length} files in the background. Query is available now and will return more results as summaries complete.`,
      }),
    }],
  };
}

async function handleQuery(args: { keywords: string; scope?: string; max?: number; format?: string }) {
  const cwd = process.cwd();
  const knowledgeDir = findKnowledgeDir(cwd) || path.join(cwd, KNOWLEDGE_DIRECTORY);

  if (!fs.existsSync(knowledgeDir)) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'No knowledge found. Run scan first.' }) }] };
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
      const prefixedPath = pathPrefix
        ? (pathPrefix + '/' + filePath).replace(/\/\//g, '/')
        : filePath;
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
    output = { query: args.keywords, keywords, scope: scope || 'all', total: limited.length, results: limited };
  }

  return { content: [{ type: 'text', text: JSON.stringify(output) }] };
}

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

const transport = new StdioServerTransport();
await server.connect(transport);
