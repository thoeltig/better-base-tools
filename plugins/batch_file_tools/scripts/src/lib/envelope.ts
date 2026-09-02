import { isAbsolute, relative } from "node:path";
import type {
  EditFile,
  EditOutput,
  FileResult,
  ReadOutput,
  ReadRequest,
  ReadResult,
  ToolContentResult,
} from "../types.js";

function shortenPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return rel.startsWith("..") || isAbsolute(rel) ? p : rel;
}

export function formatReadContent(
  result: ReadOutput,
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
    const truncated = truncateReadBlock(r, maxChars - usedChars);
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

  if (noMatchResults.length > 0) {
    const noMatchBlock = buildNoMatchBlock(noMatchResults);
    if (!stopped && (maxChars <= 0 || usedChars + noMatchBlock.text.length <= maxChars)) {
      output.push(noMatchBlock);
      usedChars += noMatchBlock.text.length;
    } else {
      omitted.push(...noMatchResults);
    }
  }

  if (omitted.length > 0) output.push(buildOmittedMarker(omitted.map(r => r.path)));
  if (addUserAudience) output.push(createToolOutputForUser(buildReadSummary(requests, result.results)));
  return output;
}

function buildNoMatchBlock(results: ReadonlyArray<ReadResult>): ToolContentResult {
  const fileList = results.map(r => `'${shortenPath(r.path)}'`).join('\n');
  return createToolOutputForAssistant(`<!-- No match(es) found -->\n${fileList}`);
}

function buildOmittedMarker(paths: ReadonlyArray<string>): ToolContentResult {
  const list = paths.map(shortenPath).join(', ');
  return {
    type: 'text',
    text: `<!-- Max output reached — could not return: ${list}. Re-request them separately. -->`,
    annotations: { audience: ['assistant', 'user'], priority: 0 },
  };
}

function truncationMarkerText(endLine: number, total: number): string {
  return `<!-- Truncated at line ${endLine} of ${total} — max output reached; re-read from line ${endLine + 1} -->`;
}

function searchTruncationMarkerText(kept: number, total: number): string {
  return `<!-- Truncated: showing first ${kept} of ${total} match block(s) — max output reached; refine the search or read the file directly -->`;
}

// How many leading units (lines or match blocks) fit into `budget` once the header
// and truncation-marker overhead is reserved. Always keeps at least one unit so a
// truncated block still carries a usable re-read anchor.
function countUnitsWithinBudget(units: ReadonlyArray<string>, budget: number, headerChars: number, markerChars: number): number {
  const contentBudget = budget - headerChars - markerChars - 2; // 2 = "\n" after header + "\n" before marker
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

function headerCharsOf(r: ReadResult): number {
  return readResultToBlock(r).text.length - r.content.length - 1; // header + separating "\n"
}

// Truncate an over-budget read block at a unit boundary, rewriting its meta header
// via readResultToBlock. Line reads truncate at line boundaries (header shows the
// reduced range); search reads truncate at match-block boundaries. Returns null for
// non-truncatable results (error/single-unit) or when nothing needs trimming.
function truncateReadBlock(r: ReadResult, budget: number): ToolContentResult | null {
  if (r.error || r.content.length === 0) return null;
  if (r.match_count !== undefined) return truncateSearchBlock(r, budget);
  if (r.returned_lines > 0) return truncateLineBlock(r, budget);
  return null;
}

function truncateLineBlock(r: ReadResult, budget: number): ToolContentResult | null {
  const startLine = r.start_line ?? 1;
  const bodyLines = (r.content.endsWith('\n') ? r.content.slice(0, -1) : r.content).split('\n');
  const markerChars = truncationMarkerText(startLine + bodyLines.length - 1, r.lines).length;
  const kept = countUnitsWithinBudget(bodyLines, budget, headerCharsOf(r), markerChars);
  if (kept >= bodyLines.length) return null;

  const endLine = startLine + kept - 1;
  const block = readResultToBlock({ ...r, returned_lines: kept, content: bodyLines.slice(0, kept).join('\n') });
  block.text += `\n${truncationMarkerText(endLine, r.lines)}`;
  return block;
}

function truncateSearchBlock(r: ReadResult, budget: number): ToolContentResult | null {
  // count>0 emits multi-line "<!-- Line M to N -->" blocks joined by "\n"; count=0
  // emits one "lineNo\tcontent" match per line.
  const blocks = r.content.startsWith('<!-- Line ')
    ? r.content.split(/\n(?=<!-- Line )/)
    : r.content.split('\n');
  const markerChars = searchTruncationMarkerText(blocks.length, blocks.length).length;
  const kept = countUnitsWithinBudget(blocks, budget, headerCharsOf(r), markerChars);
  if (kept >= blocks.length) return null;

  const block = readResultToBlock({ ...r, content: blocks.slice(0, kept).join('\n') });
  block.text += `\n${searchTruncationMarkerText(kept, blocks.length)}`;
  return block;
}

export function formatEditContent(result: EditOutput, files: ReadonlyArray<EditFile> = [], addUserAudience = false, dryRun?: boolean): ToolContentResult[] {
  const allResults = result.results;
  const totalOps = allResults.reduce((sum, r) => sum + r.totalOps, 0);
  const nonOkOps = allResults.reduce((sum, r) => sum + r.ops.length, 0);
  const okOps = totalOps - nonOkOps;
  const fileCount = allResults.length;
  const dryTag = dryRun ? "DRY RUN: " : "";
  const fileLabel = fileCount === 1 ? "file" : "files";

  const errorFiles = allResults.filter(r => r.status === "error" || r.status === "partial");
  const skippedFiles = allResults.filter(r => r.status === "skipped");
  const hasProblems = errorFiles.length > 0 || skippedFiles.length > 0;

  if (!hasProblems) {
    const output = [createToolOutputForAssistant(`<!-- ${dryTag}Edit: ${fileCount} ${fileLabel}, ${okOps} ops successful -->`)];
    if (addUserAudience) output.push(createToolOutputForUser(buildEditSummary(files, result.results)));
    return output;
  }

  const allLines: string[] = [`<!-- ${dryTag}Edit: ${fileCount} ${fileLabel}, ${okOps}/${totalOps} ops successful -->`];

  for (const r of [...errorFiles, ...skippedFiles]) {
    const fileNonOkOps = r.ops.length;
    const fileTotalOps = r.totalOps;
    const fileOkOps = fileTotalOps - fileNonOkOps;
    const fileLines: string[] = [
      `<!-- '${shortenPath(r.path)}': ${fileOkOps}/${fileTotalOps} ops successful -->`,
    ];

    if (r.status === "skipped") {
      fileLines.push(`<!-- file; skipped -->`);
    } else if (r.error) {
      fileLines.push(`<!-- file error: ${r.error.reason}: ${r.error.message} -->`);
    } else {
      const skippedIdxs: number[] = [];
      for (const op of r.ops) {
        if (op.status === "skipped") {
          skippedIdxs.push(op.index ?? 0);
          continue;
        }
        if (op.status !== "error") continue;

        const idx = op.index ?? 0;
        const type = op.type ?? "unknown";
        let errorMsg = op.hint?.next_action ?? op.reason ?? "error";
        if (op.hint?.nearest_anchor) {
          errorMsg = errorMsg.replace(/ — nearest similar line is \d+.*$/, "");
        }

        let line = `<!-- op ${idx} (${type}); error: ${errorMsg}`;
        const anchor = op.hint?.nearest_anchor;
        if (anchor) line += `; possible verbatim anchor: lines ${anchor.start_line}-${anchor.end_line}`;
        if (op.hint?.match_lines?.length) line += `; matches at lines ${op.hint.match_lines.join(", ")}`;
        line += ` -->`;

        fileLines.push(line);
        if (anchor) fileLines.push(anchor.content.replace(/\n$/, ""));
      }

      if (skippedIdxs.length > 0) {
        const first = Math.min(...skippedIdxs);
        const last = Math.max(...skippedIdxs);
        const range = first === last ? `op ${first}` : `ops ${first} to ${last}`;
        fileLines.push(`<!-- ${range}; skipped -->`);
      }
    }

    allLines.push(fileLines.join("\n"));
  }

  const output = [createToolOutputForAssistant(allLines.join("\n\n"))];
  if (addUserAudience) output.push(createToolOutputForUser(buildEditSummary(files, result.results)));
  return output;
}

function readResultToBlock(r: ReadResult): ToolContentResult {
  let hint = "";
  if (r.error) {
    hint = `<!-- '${r.error.reason}' error reading file '${shortenPath(r.path)}' as '${r.mode_applied}': ${r.error.message} -->`;
  } else if (r.match_count !== undefined) {
    hint = `<!-- Found ${r.match_count} match(es) in ${r.lines} lines of '${shortenPath(r.path)}' as '${r.mode_applied}' -->`;
  } else if (r.returned_lines === 0) {
    hint = `<!-- Read 0 lines of file '${shortenPath(r.path)}' as '${r.mode_applied}' -->`;
  } else {
    const startLine = r.start_line ?? 1;
    const endLine = startLine + r.returned_lines - 1;
    const linesInfo = r.returned_lines < r.lines
      ? `${r.returned_lines} of ${r.lines} lines total`
      : `${r.lines} ${r.lines === 1 ? "line" : "lines"} total`;
    const lineRange = startLine === endLine ? `line ${startLine}` : `line ${startLine} to ${endLine}`;
    hint = `<!-- Read ${lineRange} of file '${shortenPath(r.path)}' as '${r.mode_applied}' (${linesInfo}) -->`;
  }
  return createToolOutputForAssistant(`${hint}\n${r.content ?? ""}`);
}

function createToolOutputForAssistant(text: string): ToolContentResult {
  return { 
    type: "text", 
    text: text, 
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
    if (r.searchTerm) searchTerms.push(r.searchTerm);
  }
  const parts: string[] = [`Read ${requests.length}`];
  parts.push([...modeCounts.entries()].map(([m, c]) => `${m}: ${c}`).join(', '));
  if (searchTerms.length > 0) parts.push('searched: ' + searchTerms.map(t => '"' + t + '"').join(', '));
  const errCount = results.filter(r => r.error).length;
  if (errCount > 0) parts.push(`${errCount} error(s)`);
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
  const parts: string[] = [`Edited ${files.length} file(s)`];
  parts.push([...opCounts.entries()].map(([t, c]) => `${t}: ${c}`).join(', '));
  if (errCount > 0) parts.push(`ok: ${okCount}, error/partial: ${errCount}`);
  return parts.join(' — ');
}
