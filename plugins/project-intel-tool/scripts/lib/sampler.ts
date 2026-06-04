import * as fs from 'fs';
import * as path from 'path';
import type { FileRefs } from './file-map.js';
import { mergeSamplingResults, toAbsReal } from './summary-merger.js';
import {
  SamplingBatch,
  SamplingFileSummary,
  SummariesData,
  SAMPLING_DELAY_MS,
  ScanConfig,
  DEFAULT_SCAN_CONFIG,
  BATCHES_DIRECTORY,
  ROLE_VALUES,
  AnalysisSubmission,
} from '../types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';

// Build intra-scan-set dependency graph (excludes already-summarized files)
function buildDepGraph(files: string[], fileMap: Map<string, FileRefs>): Map<string, Set<string>> {
  const fileSet = new Set(files);
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const refs = fileMap.get(file);
    const deps = new Set<string>();
    if (refs) {
      refs.refs
        .filter(r => fileSet.has(r))
        .forEach(r => deps.add(r));
    }
    graph.set(file, deps);
  }
  return graph;
}

// Topological layers: layer 0 = no intra-set deps, layer N+1 = all deps in previous layers
function topoLayers(graph: Map<string, Set<string>>): string[][] {
  const layers: string[][] = [];
  const placed = new Set<string>();
  const all = [...graph.keys()];

  while (placed.size < all.length) {
    const layer = all.filter(f => {
      if (placed.has(f)) return false;
      return [...(graph.get(f) || [])].every(d => placed.has(d));
    });
    // Guard against circular deps: force remaining files into final layer
    const toAdd = layer.length > 0 ? layer : all.filter(f => !placed.has(f));
    toAdd.forEach(f => placed.add(f));
    layers.push(toAdd);
  }
  return layers;
}

function estimateTokens(filePath: string, fileMap: Map<string, FileRefs>, numContextFiles: number, charsPerToken: number): number {
  const refs = fileMap.get(filePath);
  const contentTokens = refs ? Math.ceil(refs.sizeChars / charsPerToken) : 500;
  return contentTokens + numContextFiles * 50 + 300; // 300 = response estimate per file
}

function buildBatch(
  files: string[],
  fileMap: Map<string, FileRefs>,
  _graph: Map<string, Set<string>>,
  summaries: SummariesData,
  summarized: Set<string>,
  charsPerToken: number,
  toAbs: (p: string) => string
): SamplingBatch {
  const contextPaths = new Set<string>();
  for (const file of files) {
    const refs = fileMap.get(file);
    for (const dep of refs?.refs ?? []) {
      if (summarized.has(toAbs(dep)) && summaries.files.get(toAbs(dep))?.summary) {
        contextPaths.add(dep);
      }
    }
  }
  const contextFiles = [...contextPaths].map(p => ({
    path: p,
    summary: summaries.files.get(toAbs(p))?.summary || '',
  }));
  const estimatedTokens = 200 + files.reduce(
    (sum, f) => sum + estimateTokens(f, fileMap, contextFiles.length, charsPerToken),
    0
  );
  return { files, contextFiles, estimatedTokens };
}

export function buildSamplingBatches(
  filesToScan: string[],
  fileMap: Map<string, FileRefs>,
  summaries: SummariesData,
  config: ScanConfig = DEFAULT_SCAN_CONFIG,
  projectRoot: string = '.'
): SamplingBatch[] {
  const graph = buildDepGraph(filesToScan, fileMap);
  const layers = topoLayers(graph);
  const batches: SamplingBatch[] = [];

  // summaries.files has abs keys; convert to relative for comparison with filesToScan/refs
  const toAbs = (p: string) => toAbsReal(projectRoot, p);
  const summarized = new Set<string>(
    [...summaries.files.entries()].filter(([, v]) => !v.deleted && v.summary).map(([k]) => k)
  );

  let carryFiles: string[] = [];
  let carryTokens = 200;

  const flush = () => {
    if (carryFiles.length === 0) return;
    batches.push(buildBatch(carryFiles, fileMap, graph, summaries, summarized, config.charsPerToken, toAbs));
    carryFiles.forEach(f => summarized.add(toAbs(f)));
    carryFiles = [];
    carryTokens = 200;
  };

  for (let li = 0; li < layers.length; li++) {
    const sorted = [...layers[li]!].sort((a, b) => {
      const da = path.dirname(a);
      const db = path.dirname(b);
      return da !== db ? da.localeCompare(db) : a.localeCompare(b);
    });

    for (const file of sorted) {
      const fileTokens = estimateTokens(
        file, fileMap,
        [...(graph.get(file) || [])].filter(d => summarized.has(toAbs(d))).length,
        config.charsPerToken
      );
      if (carryTokens + fileTokens > config.maxTokensPerBatch && carryFiles.length > 0) {
        flush();
      }
      carryFiles.push(file);
      carryTokens += fileTokens;
    }

    const isLastLayer = li === layers.length - 1;
    if (isLastLayer || carryTokens >= config.minBatchTokens) {
      flush();
    }
  }
  flush();

  return batches;
}

const INDENT_SENSITIVE_EXTS = new Set(['.py', '.yaml', '.yml', '.pug', '.haml', '.coffee']);

function compactContent(content: string, ext: string): string {
  if (INDENT_SENSITIVE_EXTS.has(ext)) {
    return content
      .split('\n')
      .map(line => {
        const trimmed = line.trimEnd();
        if (!trimmed) return null;
        const indent = (line.match(/^(\s*)/)?.[1] || '').replace(/\t/g, '  ');
        return indent + trimmed.trimStart();
      })
      .filter((l): l is string => l !== null)
      .join('\n');
  }
  return content.replace(/\s+/g, ' ').trim();
}

function buildPrompt(batch: SamplingBatch, projectRoot: string, log: SamplerLog): string | null {
  const fileSections: string[] = [];

  for (const filePath of batch.files) {
    const absPath = path.resolve(projectRoot, filePath);
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      const content = compactContent(raw, path.extname(filePath).toLowerCase());
      fileSections.push(`<file path="${filePath}">\n${content}\n</file>`);
    } catch {
      log('warning', `Cannot read ${filePath}, skipping`);
    }
  }

  if (fileSections.length === 0) return null;

  const contextSection = batch.contextFiles.length > 0
    ? `\nReferenced files (context only, do not summarize these):\n${batch.contextFiles.map(c => `- ${c.path}: ${c.summary}`).join('\n')}\n`
    : '';

  return `Analyze the following ${batch.files.length} file(s). Return a JSON array with one object per file:
[{
  "path": "<exact file path from input>",
  "summary": "<explain content, purpose and key information for understanding this file's role in the codebase — max 450 chars>",
  "role": "<${ROLE_VALUES.join('|')}>",
  "technologies": ["<2-5 key techs>"],
  "searchTags": ["<additional search words not in summary, role, or technologies that help locate this file>"]
}]
${contextSection}
Files to analyze:
${fileSections.join('\n\n')}

Return only the JSON array. No markdown, no explanation.`;
}

export type SamplerLog = (level: 'info' | 'warning' | 'error', msg: string) => void;
export type SamplerProgress = (done: number, total: number, message: string) => Promise<void> | void;

export async function runSampling(
  batches: SamplingBatch[],
  server: McpServer,
  knowledgeDir: string,
  projectRoot: string,
  signal: AbortSignal,
  log: SamplerLog = () => {},
  onProgress?: SamplerProgress,
  delayMs: number = SAMPLING_DELAY_MS
): Promise<void> {
  log('info', `Starting: ${batches.length} batch(es)`);

  for (const [i, batch] of batches.entries()) {
    if (signal.aborted) { log('info', 'Aborted'); return; }

    try {
      const prompt = buildPrompt(batch, projectRoot, log);
      if (!prompt) { log('warning', `Batch ${i + 1} has no readable files, skipping`); continue; }
      log('info', `Batch ${i + 1}/${batches.length}: ${batch.files.length} file(s) (~${batch.estimatedTokens} tokens)`);

      const response = await server.server.request(
        {
          method: 'sampling/createMessage',
          params: {
            messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
            systemPrompt: 'You analyze source code files and return structured JSON summaries. Return only a valid JSON array, no markdown, no explanation.',
            maxTokens: batch.files.length * 300,
            modelPreferences: {
              hints: [{ name: 'haiku' }, { name: 'claude-3-5-haiku' }],
              speedPriority: 0.8,
              costPriority: 1.0,
              intelligencePriority: 0.2,
            },
          },
        },
        AnalysisSubmission
      );

      if (signal.aborted) { log('info', 'Aborted after response, discarding'); return; }

      if (response?.results) {
        mergeSamplingResults(knowledgeDir, response.results as SamplingFileSummary[], projectRoot);
        log('info', `Batch ${i + 1} saved: ${response.results.length} file(s)`);
      }
    } catch (err) {
      log('error', `Batch ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await onProgress?.(i + 1, batches.length, `Batch ${i + 1}/${batches.length}: ${batch.files.length} file(s)`);

    if (i < batches.length - 1) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  log('info', 'Complete');
}

export function writeBatchFiles(batches: SamplingBatch[], knowledgeDir: string, projectRoot: string): string[] {
  const batchDir = path.join(knowledgeDir, BATCHES_DIRECTORY);
  if (fs.existsSync(batchDir)) {
    for (const f of fs.readdirSync(batchDir)) {
      if (/^batch-\d+\.txt$/.test(f))
        try { fs.unlinkSync(path.join(batchDir, f)); } catch {}
    }
  } else {
    fs.mkdirSync(batchDir, { recursive: true });
  }
  const noopLog: SamplerLog = () => {};
  return batches.map((batch, i) => {
    const fp = path.join(batchDir, `batch-${i}.txt`);
    const basePrompt = buildPrompt(batch, projectRoot, noopLog) ?? '';
    const prompt = basePrompt
      ? basePrompt.replace(
          'Return only the JSON array. No markdown, no explanation.',
          `Use ToolSearch with query 'submit_analysis' to load the 'submit_analysis' tool, then call it with your analysis results. Do not invoke any other skills or tools. When you are finished return only 'Done', no additional output or explanation needed.`
        )
      : '';
    fs.writeFileSync(fp, prompt);
    return fp;
  });
}
