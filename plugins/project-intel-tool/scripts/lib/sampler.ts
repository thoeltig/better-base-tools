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
    const fr = fileMap.get(file);
    const deps = new Set<string>();
    if (fr) {
      // Local import deps (imports keys that are in the scan set)
      Object.keys(fr.imports).filter(k => fileSet.has(k)).forEach(k => deps.add(k));
      // Text-mention deps
      fr.refs.filter(r => fileSet.has(r)).forEach(r => deps.add(r));
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
  summaries: SummariesData,
  summarized: Set<string>,
  charsPerToken: number,
  toAbs: (p: string) => string
): SamplingBatch {
  const fileSet = new Set(files);
  const contextReferencedBy = new Map<string, Set<string>>();

  for (const file of files) {
    const fr = fileMap.get(file);
    const allDeps = [...Object.keys(fr?.imports ?? {}), ...(fr?.refs ?? [])];
    for (const dep of allDeps) {
      if (summarized.has(toAbs(dep)) && summaries.files.get(toAbs(dep))?.summary) {
        const refs = contextReferencedBy.get(dep) ?? new Set<string>();
        refs.add(file);
        contextReferencedBy.set(dep, refs);
      }
    }
  }

  const contextFiles = [...contextReferencedBy.entries()].map(([p, refBy]) => ({
    path: p,
    summary: summaries.files.get(toAbs(p))?.summary || '',
    referencedBy: [...refBy],
  }));

  const contextPathSet = new Set(contextReferencedBy.keys());
  const fileRefs: Record<string, string[]> = {};
  for (const file of files) {
    const fr = fileMap.get(file);
    if (!fr) continue;
    const entries: string[] = [];
    for (const [k, names] of Object.entries(fr.imports)) {
      if (fileSet.has(k) || contextPathSet.has(k)) {
        entries.push(names.length ? `${k}: ${names.join(', ')}` : k);
      }
    }
    if (entries.length > 0) fileRefs[file] = entries;
  }

  const estimatedTokens = 200 + files.reduce(
    (sum, f) => sum + estimateTokens(f, fileMap, contextFiles.length, charsPerToken),
    0
  );
  return { files, fileRefs, contextFiles, estimatedTokens };
}

export function buildSamplingBatches(
  filesToScan: string[],
  fileMap: Map<string, FileRefs>,
  summaries: SummariesData,
  config: ScanConfig = DEFAULT_SCAN_CONFIG,
  projectRoot: string = '.'
): SamplingBatch[] {
  const fileSet = new Set(filesToScan);
  const toAbs = (p: string) => toAbsReal(projectRoot, p);
  const summarized = new Set<string>(
    [...summaries.files.entries()].filter(([, v]) => !v.deleted && v.summary).map(([k]) => k)
  );

  // Union-Find
  const parent = new Map<string, string>();
  for (const f of filesToScan) parent.set(f, f);
  const find = (x: string): string => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  const union = (x: string, y: string): void => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  // Cohesion edge: A imports B or A refs B (both in scan set)
  for (const file of filesToScan) {
    const fr = fileMap.get(file);
    for (const k of Object.keys(fr?.imports ?? {})) {
      if (fileSet.has(k)) union(file, k);
    }
    for (const r of (fr?.refs ?? [])) {
      if (fileSet.has(r)) union(file, r);
    }
  }

  // Cohesion edge: A and B share a summarized intra-project dep
  const summarizedDepToFiles = new Map<string, string[]>();
  for (const file of filesToScan) {
    for (const k of Object.keys(fileMap.get(file)?.imports ?? {})) {
      const absK = toAbs(k);
      if (summarized.has(absK)) {
        const list = summarizedDepToFiles.get(absK) ?? [];
        list.push(file);
        summarizedDepToFiles.set(absK, list);
      }
    }
  }
  for (const files of summarizedDepToFiles.values()) {
    for (let i = 1; i < files.length; i++) union(files[0]!, files[i]!);
  }

  // Group into components
  const componentMap = new Map<string, string[]>();
  for (const file of filesToScan) {
    const root = find(file);
    const list = componentMap.get(root) ?? [];
    list.push(file);
    componentMap.set(root, list);
  }

  // Topo-sort within each component (deps first), then sort components by first file
  const sortedComponents = [...componentMap.values()].map(files => {
    const subGraph = buildDepGraph(files, fileMap);
    return topoLayers(subGraph).flatMap(l => [...l].sort((a, b) => a.localeCompare(b)));
  }).sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));

  // Pack components into batches by token budget
  const batches: SamplingBatch[] = [];
  const summarizedNow = new Set(summarized);
  let carryFiles: string[] = [];
  let carryTokens = 200;

  const flush = () => {
    if (carryFiles.length === 0) return;
    batches.push(buildBatch(carryFiles, fileMap, summaries, summarizedNow, config.charsPerToken, toAbs));
    carryFiles.forEach(f => summarizedNow.add(toAbs(f)));
    carryFiles = [];
    carryTokens = 200;
  };

  const addFile = (file: string) => {
    const ft = estimateTokens(file, fileMap, 0, config.charsPerToken);
    if (carryTokens + ft > config.maxTokensPerBatch && carryFiles.length > 0) flush();
    carryFiles.push(file);
    carryTokens += ft;
  };

  for (const component of sortedComponents) {
    const componentTokens = component.reduce(
      (sum, f) => sum + estimateTokens(f, fileMap, 0, config.charsPerToken), 0
    );
    if (componentTokens > config.maxTokensPerBatch) {
      // Oversized component: flush current, split file-by-file in topo order
      flush();
      for (const file of component) addFile(file);
      flush();
    } else if (carryTokens + componentTokens > config.maxTokensPerBatch) {
      flush();
      carryFiles.push(...component);
      carryTokens += componentTokens;
    } else {
      carryFiles.push(...component);
      carryTokens += componentTokens;
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

function buildPrompt(batch: SamplingBatch, projectRoot: string, action: string, log: SamplerLog): string | null {
  const fileSections: string[] = [];

  for (const filePath of batch.files) {
    const absPath = path.resolve(projectRoot, filePath);
    try {
      const raw = fs.readFileSync(absPath, 'utf-8');
      const content = compactContent(raw, path.extname(filePath).toLowerCase());
      const refs = batch.fileRefs[filePath];
      const importsAttr = refs?.length ? ` imports="${refs.join(' | ')}"` : '';
      fileSections.push(`<file path="${filePath}"${importsAttr}>\n${content}\n</file>`);
    } catch {
      log('warning', `Cannot read ${filePath}, skipping`);
    }
  }

  if (fileSections.length === 0) return null;

  const contextSection = batch.contextFiles.length > 0
    ? `\n--- Additional Context ---\n${batch.contextFiles.map(c =>
        `<context path="${c.path}" referenced_by="${c.referencedBy.join(',')}">
${c.summary}
</context>`
      ).join('\n')}\n`
    : '';

  const actionSection = action ? `\n${action}\n` : '';

  return `Analyze the following ${batch.files.length} file(s). Return a JSON array with one object per file:
[{
  "path": "<exact file path from input>",
  "summary": "<explain content, purpose and key information for understanding this file's role in the codebase — max 450 chars>",
  "role": "<${ROLE_VALUES.join('|')}>",
  "technologies": ["<2-5 key techs>"],
  "searchTags": ["<additional search words not in summary, role, or technologies that help locate this file>"]
}]
${actionSection}${contextSection}
--- Files to Analyze ---
${fileSections.join('\n\n')}`;
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
      const prompt = buildPrompt(batch, projectRoot, 'Return only the JSON array. No markdown, no explanation.', log);
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
  // Behaviour instructions live in the project-intel-analyst agent definition, not in the batch file.
  return batches.map((batch, i) => {
    const fp = path.join(batchDir, `batch-${i}.txt`);
    const prompt = buildPrompt(batch, projectRoot, '', noopLog) ?? '';
    fs.writeFileSync(fp, prompt);
    return fp;
  });
}
