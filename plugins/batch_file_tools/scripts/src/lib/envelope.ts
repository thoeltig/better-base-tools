import { isAbsolute, relative } from "node:path";
import { forwardSlashes } from "./fs.js";
import { formatForRead } from "./transforms.js";
import type {
  EditFile,
  EditOutput,
  FileResult,
  ReadOutput,
  ReadOutputWithSources,
  ReadRequest,
  FileError,
  ReadResult,
  SearchCount,
  ToolContentResult,
} from "../types.js";

function shortenPath(p: string): string {
  const rel = relative(process.cwd(), p);
  const shown = rel.startsWith("..") || isAbsolute(rel) ? p : rel;
  return forwardSlashes(shown);
}

// not_found shows the absolute path so a wrong resolution base (server cwd) is visible.
function errorComment(p: string, error: FileError): string {
  const shownPath = error.reason === "not_found" ? forwardSlashes(p) : shortenPath(p);
  const detail = error.message ? ` — ${error.message}` : "";
  return `<!-- Error ${error.reason}: '${shownPath}'${detail} -->`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatReadContent(
  result: ReadOutput & Partial<Pick<ReadOutputWithSources, "sources">>,
  requests: ReadonlyArray<ReadRequest> = [],
  addUserAudience = false,
  maxChars = 0,
): ToolContentResult[] {
  const noMatchResults: ReadResult[] = [];
  const otherResults: ReadResult[] = [];
  for (const r of result.results) {
    if (r.match_count === 0 && !r.error) {
      noMatchResults.push(r);
    } else {
      otherResults.push(r);
    }
  }

  const output: ToolContentResult[] = [];
  const omitted: ReadResult[] = [];
  let usedChars = 0;
  let stopped = false;

  for (const r of otherResults) {
    if (stopped) {
      omitted.push(r);
      continue;
    }
    const block = readResultToBlock(r);
    if (maxChars <= 0 || usedChars + block.text.length <= maxChars) {
      output.push(block);
      usedChars += block.text.length;
      continue;
    }
    // Block exceeds the remaining budget: truncate line-oriented reads at a line
    // boundary, emit a non-truncatable first block whole to guarantee progress,
    // otherwise defer the whole file to the omitted list.
    const truncated = truncateReadBlock(r, maxChars - usedChars, result.sources?.get(r.path));
    if (truncated) {
      output.push(truncated);
      usedChars += truncated.text.length;
    } else if (output.length === 0) {
      output.push(block);
      usedChars += block.text.length;
    } else {
      omitted.push(r);
    }
    stopped = true;
  }

  const noMatchBlock = buildNoMatchBlock(result.results);
  if (noMatchBlock) output.push(noMatchBlock);

  if (omitted.length > 0) output.push(buildOmittedMarker(omitted.map(r => r.path)));
  if (addUserAudience) output.push(createToolOutputForUser(buildReadSummary(requests, result.results)));
  return output;
}

// One line per search that matched in no file; files without matches are otherwise
// omitted like grep does. Tiny, so emitted outside the output budget.
function buildNoMatchBlock(results: ReadonlyArray<ReadResult>): ToolContentResult | null {
  const matched = new Set<string>();
  const unmatched = new Map<string, string>();
  for (const search of results.flatMap(r => r.searches ?? [])) {
    if (search.match_count > 0) matched.add(searchIdentity(search));
    else unmatched.set(searchIdentity(search), searchLabel(search));
  }
  const labels = [...unmatched].filter(([identity]) => !matched.has(identity)).map(([, label]) => label);
  if (labels.length === 0) return null;
  return createToolOutputForAssistant(labels.map(label => `<!-- No matches for ${label} -->`).join('\n'));
}

// Groups by the raw search: escaped labels of a real line break and a literal "\n" would collide.
function searchIdentity(search: SearchCount): string {
  return search.search_term !== undefined ? `term:${search.search_term}` : `regex:${search.search_regex ?? ""}`;
}

function searchLabel(search: SearchCount): string {
  return search.search_term !== undefined
    ? `'${escapeLineBreaks(search.search_term)}'`
    : `/${escapeLineBreaks(search.search_regex ?? "")}/`;
}

// Keeps a multi-line search on the single header line.
function escapeLineBreaks(text: string): string {
  return text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function buildOmittedMarker(paths: ReadonlyArray<string>): ToolContentResult {
  const list = paths.map(shortenPath).join(', ');
  return {
    type: 'text',
    text: `<!-- Max output reached — could not return: ${list}. Re-request them separately. -->\n`,
    annotations: { audience: ['assistant', 'user'], priority: 0 },
  };
}

function truncationMarkerText(endLine: number, total: number): string {
  return `<!-- Truncated at line ${endLine} of ${total} — max output reached; re-read from line ${endLine + 1} -->`;
}

function searchTruncationMarkerText(kept: number, total: number): string {
  return `<!-- Truncated: showing first ${kept} of ${plural(total, "result line")} — max output reached; refine the search or read the file directly -->`;
}

// How many leading search result lines fit into `budget` once the header and truncation-marker
// overhead is reserved. Always keeps at least one so a truncated block stays useful.
function countUnitsWithinBudget(units: ReadonlyArray<string>, budget: number, headerChars: number, markerChars: number): number {
  const contentBudget = budget - headerChars - markerChars - 3; // 3 = "\n" after header, content and marker
  let kept = 0;
  let contentChars = 0;
  for (const unit of units) {
    const cost = kept === 0 ? unit.length : unit.length + 1; // +1 for the joining "\n"
    if (kept > 0 && contentChars + cost > contentBudget) break;
    contentChars += cost;
    kept++;
  }
  return kept;
}

// Truncate an over-budget read block at a unit boundary, rewriting its meta header
// via readResultToBlock. Line reads truncate at line boundaries (header shows the
// reduced range); search reads truncate at match-block boundaries. Returns null for
// non-truncatable results (error/single-unit) or when nothing needs trimming.
function truncateReadBlock(r: ReadResult, budget: number, source: string | undefined): ToolContentResult | null {
  if (r.error || r.content.length === 0) return null;
  if (r.searches !== undefined) return truncateSearchBlock(r, budget);
  if (r.returned_lines > 0) return truncateLineBlock(r, budget, source);
  return null;
}

// Re-slices the raw source and re-formats it, because compact output does not map
// 1:1 to source lines. Binary search for the most source lines that fit; keeps at least one.
function truncateLineBlock(r: ReadResult, budget: number, source: string | undefined): ToolContentResult | null {
  if (source === undefined || r.returned_lines <= 1) return null;
  const startLine = r.start_line ?? 1;
  const blockFor = (lineCount: number): ToolContentResult => {
    const { content } = formatForRead({ content: source, mode: r.mode_applied, path: r.path, offset: startLine, limit: lineCount });
    const block = readResultToBlock({ ...r, returned_lines: lineCount, content });
    block.text += `${truncationMarkerText(startLine + lineCount - 1, r.lines)}\n`;
    return block;
  };

  let best = blockFor(1);
  let low = 2;
  let high = r.returned_lines - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = blockFor(mid);
    if (candidate.text.length <= budget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function truncateSearchBlock(r: ReadResult, budget: number): ToolContentResult | null {
  // Every search output line is one labelled unit ("N:\t" or a compact "M-N:\t" run).
  const blocks = r.content.split("\n");
  const markerChars = searchTruncationMarkerText(blocks.length, blocks.length).length;
  const kept = countUnitsWithinBudget(blocks, budget, readResultHeader(r).length, markerChars);
  if (kept >= blocks.length) return null;

  const block = readResultToBlock({ ...r, content: blocks.slice(0, kept).join('\n') });
  block.text += `${searchTruncationMarkerText(kept, blocks.length)}\n`;
  return block;
}

export function formatEditContent(result: EditOutput, files: ReadonlyArray<EditFile> = [], addUserAudience = false, dryRun?: boolean): ToolContentResult[] {
  const allResults = result.results;
  const totalOps = allResults.reduce((sum, r) => sum + r.totalOps, 0);
  const nonOkOps = allResults.reduce((sum, r) => sum + r.ops.length, 0);
  const okOps = totalOps - nonOkOps;
  const fileCount = allResults.length;
  const dryTag = dryRun ? "DRY RUN: " : "";

  const errorFiles = allResults.filter(r => r.status === "error" || r.status === "partial");
  const skippedFiles = allResults.filter(r => r.status === "skipped");
  const hasProblems = errorFiles.length > 0 || skippedFiles.length > 0;

  if (!hasProblems) {
    const output = [createToolOutputForAssistant(`<!-- ${dryTag}Edit: ${plural(fileCount, "file")}, ${plural(okOps, "op")} successful -->`)];
    if (addUserAudience) output.push(createToolOutputForUser(buildEditSummary(files, result.results)));
    return output;
  }

  const allLines: string[] = [`<!-- ${dryTag}Edit: ${plural(fileCount, "file")}, ${okOps}/${totalOps} ops successful -->`];

  for (const r of [...errorFiles, ...skippedFiles]) {
    if (r.error) {
      allLines.push(errorComment(r.path, r.error));
      continue;
    }
    const fileNonOkOps = r.ops.length;
    const fileTotalOps = r.totalOps;
    const fileOkOps = fileTotalOps - fileNonOkOps;
    const fileLines: string[] = [
      `<!-- '${shortenPath(r.path)}': ${fileOkOps}/${fileTotalOps} ops successful -->`,
    ];

    if (r.status === "skipped") {
      fileLines.push(`<!-- file; skipped -->`);
    } else {
      // Skipped ops are named individually and emitted after the errors: execution order differs
      // from request order, so a count alone would not say which ops landed and which did not.
      const skippedLines: string[] = [];
      for (const op of r.ops) {
        if (op.status === "skipped") {
          const skippedTarget = op.target ? ` ${op.target}` : "";
          skippedLines.push(`<!-- op (${op.type ?? "unknown"})${skippedTarget}; skipped -->`);
          continue;
        }
        if (op.status !== "error") continue;

        const type = op.type ?? "unknown";
        const target = op.target ? ` ${op.target}` : "";
        let errorMsg = op.hint?.next_action ?? op.reason ?? "error";
        if (op.hint?.nearest_anchor) {
          errorMsg = errorMsg.replace(/ — nearest similar line is \d+.*$/, "");
        }

        let line = `<!-- op (${type})${target}; error: ${errorMsg}`;
        const anchor = op.hint?.nearest_anchor;
        if (anchor) line += `; possible verbatim anchor: lines ${anchor.start_line}-${anchor.end_line}`;
        if (op.hint?.match_lines?.length) line += `; matches at lines ${op.hint.match_lines.join(", ")}`;
        line += ` -->`;

        fileLines.push(line);
        if (anchor) fileLines.push(anchor.content.replace(/\n$/, ""));
      }

      fileLines.push(...skippedLines);
    }

    allLines.push(fileLines.join("\n"));
  }

  const output = [createToolOutputForAssistant(allLines.join("\n\n"))];
  if (addUserAudience) output.push(createToolOutputForUser(buildEditSummary(files, result.results)));
  return output;
}

function readResultToBlock(r: ReadResult): ToolContentResult {
  return createToolOutputForAssistant(`${readResultHeader(r)}\n${r.content ?? ""}`);
}

function readResultHeader(r: ReadResult): string {
  if (r.error) return errorComment(r.path, r.error);
  const file = `'${shortenPath(r.path)}'`;
  if (r.searches !== undefined) {
    // Only searches that matched here; ones matching nowhere get the global no-match line.
    const counts = r.searches.filter(s => s.match_count > 0).map(s => `${searchLabel(s)}: ${s.match_count}`).join(", ");
    return `<!-- ${file} (${plural(r.lines, "line")}) as ${r.mode_applied} — ${counts} -->`;
  }
  if (r.returned_lines === r.lines) {
    return `<!-- ${plural(r.lines, "line")} in ${file} as ${r.mode_applied} -->`;
  }
  const startLine = r.start_line ?? 1;
  const endLine = startLine + r.returned_lines - 1;
  const lineRange = endLine <= startLine ? `Line ${startLine}` : `Line ${startLine} to ${endLine}`;
  return `<!-- ${lineRange} of ${plural(r.lines, "line")} in ${file} as ${r.mode_applied} -->`;
}

function createToolOutputForAssistant(text: string): ToolContentResult {
  return { 
    type: "text", 
    text: text.endsWith("\n") ? text : `${text}\n`, 
    annotations: { 
      audience: ['assistant'], 
      priority: 0.8,
      lastModified: new Date().toISOString()
    }
  };
}

function createToolOutputForUser(text: string): ToolContentResult {
  return { 
    type: "text", 
    text: text, 
    annotations: { 
      audience: ['user'], 
      priority: 0
    }
  };
}

function buildReadSummary(
  requests: ReadonlyArray<ReadRequest>,
  results: ReadonlyArray<ReadResult>,
): string {
  const modeCounts = new Map<string, number>();
  const searchTerms: string[] = [];
  for (const r of requests) {
    const m = r.mode ?? 'compact';
    modeCounts.set(m, (modeCounts.get(m) ?? 0) + 1);
    if (r.searchTerm) searchTerms.push(`"${r.searchTerm}"`);
    if (r.searchRegex) searchTerms.push(`/${r.searchRegex}/`);
  }
  const parts: string[] = [`Read ${requests.length}`];
  parts.push([...modeCounts.entries()].map(([m, c]) => `${m}: ${c}`).join(', '));
  if (searchTerms.length > 0) parts.push('searched: ' + searchTerms.join(', '));
  const errCount = results.filter(r => r.error).length;
  if (errCount > 0) parts.push(plural(errCount, "error"));
  return parts.join(' — ');
}

function buildEditSummary(
  files: ReadonlyArray<EditFile>,
  results: ReadonlyArray<FileResult>,
): string {
  const opCounts = new Map<string, number>();
  for (const f of files) {
    for (const op of f.ops) {
      opCounts.set(op.type, (opCounts.get(op.type) ?? 0) + 1);
    }
  }
  const okCount = results.filter(r => r.status === 'ok').length;
  const errCount = results.filter(r => r.status === 'error' || r.status === 'partial').length;
  const parts: string[] = [`Edited ${plural(files.length, "file")}`];
  parts.push([...opCounts.entries()].map(([t, c]) => `${t}: ${c}`).join(', '));
  if (errCount > 0) parts.push(`ok: ${okCount}, error/partial: ${errCount}`);
  return parts.join(' — ');
}
