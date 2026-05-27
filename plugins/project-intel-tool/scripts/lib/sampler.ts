import * as fs from 'fs';
import * as path from 'path';
import type { FileRefs } from './file-map.js';
import { mergeSamplingResults } from './summary-merger.js';
import {
  SamplingBatch,
  SamplingFileSummary,
  SummariesData,
  SAMPLING_DELAY_MS,
  SAMPLING_TOKEN_BUDGET,
} from '../types.js';

// Loosely typed to avoid hard MCP SDK coupling in lib; cast server to this in index.ts
export type SamplingServer = {
  request(req: unknown, schema: unknown): Promise<{ content: { type: string; text: string } }>;
};

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

function estimateTokens(filePath: string, fileMap: Map<string, FileRefs>, numContextFiles: number): number {
  const refs = fileMap.get(filePath);
  const contentTokens = refs ? Math.ceil(refs.sizeChars / 2.5) : 500;
  return contentTokens + numContextFiles * 50 + 300; // 300 = response estimate per file
}

function buildBatch(
  files: string[],
  fileMap: Map<string, FileRefs>,
  _graph: Map<string, Set<string>>,
  summaries: SummariesData,
  summarized: Set<string>
): SamplingBatch {
  const contextPaths = new Set<string>();
  for (const file of files) {
    const refs = fileMap.get(file);
    // Use all refs from the file map (includes deps outside the scan set)
    for (const dep of refs?.refs ?? []) {
      if (summarized.has(dep) && summaries.files.get(dep)?.summary) {
        contextPaths.add(dep);
      }
    }
  }
  const contextFiles = [...contextPaths].map(p => ({
    path: p,
    summary: summaries.files.get(p)?.summary || '',
  }));
  const estimatedTokens = 200 + files.reduce(
    (sum, f) => sum + estimateTokens(f, fileMap, contextFiles.length),
    0
  );
  return { files, contextFiles, estimatedTokens };
}

export function buildSamplingBatches(
  filesToScan: string[],
  fileMap: Map<string, FileRefs>,
  summaries: SummariesData
): SamplingBatch[] {
  const graph = buildDepGraph(filesToScan, fileMap);
  const layers = topoLayers(graph);
  const batches: SamplingBatch[] = [];
  // Already-summarized files are available as context from the start
  const summarized = new Set<string>(
    [...summaries.files.entries()].filter(([, v]) => !v.deleted && v.summary).map(([k]) => k)
  );

  for (const layer of layers) {
    let currentFiles: string[] = [];
    let currentTokens = 200; // overhead

    for (const file of layer) {
      const deps = [...(graph.get(file) || [])].filter(d => summarized.has(d));
      const fileTokens = estimateTokens(file, fileMap, deps.length);

      if (currentTokens + fileTokens > SAMPLING_TOKEN_BUDGET && currentFiles.length > 0) {
        batches.push(buildBatch(currentFiles, fileMap, graph, summaries, summarized));
        currentFiles = [];
        currentTokens = 200;
      }
      currentFiles.push(file);
      currentTokens += fileTokens;
    }
    if (currentFiles.length > 0) {
      batches.push(buildBatch(currentFiles, fileMap, graph, summaries, summarized));
    }
    layer.forEach(f => summarized.add(f));
  }
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

function buildPrompt(batch: SamplingBatch, projectRoot: string): string | null {
  const fileSections: string[] = [];

  for (const filePath of batch.files) {
    const absPath = path.resolve(projectRoot, filePath);
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      const content = compactContent(raw, path.extname(filePath).toLowerCase());
      fileSections.push(`<file path="${filePath}">\n${content}\n</file>`);
    } catch {
      console.error(`[sampler] Cannot read ${filePath}, skipping`);
    }
  }

  if (fileSections.length === 0) return null;

  const contextSection = batch.contextFiles.length > 0
    ? `\nReferenced files (context only, do not summarize these):\n${batch.contextFiles.map(c => `- ${c.path}: ${c.summary}`).join('\n')}\n`
    : '';

  return `Analyze the following ${batch.files.length} file(s). Return a JSON array with one object per file:
[{
  "path": "<exact file path from input>",
  "summary": "<one sentence, max 150 chars>",
  "purpose": "<three sentences: what it does, key technical details, how it connects to the rest of the codebase — max 450 chars>",
  "role": "<implementation|documentation|configuration|test|build|script>",
  "technologies": ["<2-5 key techs>"]
}]
${contextSection}
Files to analyze:
${fileSections.join('\n\n')}

Return only the JSON array. No markdown, no explanation.`;
}

function parseResponse(text: string): SamplingFileSummary[] {
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const arrMatch = clean.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
    const objMatch = clean.match(/\{[\s\S]*\}/);
    if (objMatch) return [JSON.parse(objMatch[0])];
    throw new Error(`Cannot parse sampling response: ${text.substring(0, 200)}`);
  }
}

export type SamplerLog = (level: 'info' | 'warning' | 'error', msg: string) => void;

export async function runSamplingBackground(
  batches: SamplingBatch[],
  server: SamplingServer,
  knowledgeDir: string,
  projectRoot: string,
  signal: AbortSignal,
  fileMap: Map<string, FileRefs>,
  log: SamplerLog = () => {},
  delayMs: number = SAMPLING_DELAY_MS
): Promise<void> {
  log('info', `Starting: ${batches.length} batch(es)`);

  for (const [i, batch] of batches.entries()) {
    if (signal.aborted) { log('info', 'Aborted'); return; }

    try {
      const prompt = buildPrompt(batch, projectRoot);
      if (!prompt) { log('warning', `Batch ${i + 1} has no readable files, skipping`); continue; }
      log('info', `Batch ${i + 1}/${batches.length}: ${batch.files.length} file(s) (~${batch.estimatedTokens} tokens)`);

      const response = await server.request(
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
        undefined
      );

      if (signal.aborted) { log('info', 'Aborted after response, discarding'); return; }

      if (response?.content?.type === 'text') {
        const results = parseResponse(response.content.text);
        // Enrich with deterministic file-map data (exports/imports/refs already pre-populated; re-apply for safety)
        const enriched = results.map(r => {
          const fm = fileMap.get(r.path);
          if (!fm) return r;
          const entry: SamplingFileSummary = { ...r, sizeChars: fm.sizeChars, lineCount: fm.lineCount };
          if (fm.refs.length > 0) entry.refs = fm.refs;
          if (fm.exports.length > 0) entry.exports = fm.exports;
          return entry;
        });
        mergeSamplingResults(knowledgeDir, enriched);
        log('info', `Batch ${i + 1} saved: ${enriched.length} file(s)`);
      }
    } catch (err) {
      log('error', `Batch ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (i < batches.length - 1) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  log('info', 'Complete');
}
