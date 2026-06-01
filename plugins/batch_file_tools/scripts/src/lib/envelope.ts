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

export function formatReadContent(result: ReadOutput, requests: ReadonlyArray<ReadRequest> = [], addUserAudience = false): ToolContentResult[] {
  const noMatchResults: ReadResult[] = [];
  const otherResults: ReadResult[] = [];
  for (const r of result.results) {
    if (r.match_count === 0 && !r.error) {
      noMatchResults.push(r);
    } else {
      otherResults.push(r);
    }
  }
  const toolResultOutput = otherResults.map(readResultToBlock);
  if (noMatchResults.length > 0) {
    const fileList = noMatchResults.map(r => `'${shortenPath(r.path)}'`).join('\n');
    toolResultOutput.push(createToolOutputForAssistant(`<!-- No match(es) found -->\n${fileList}`));
  }
  if (addUserAudience) toolResultOutput.push(createToolOutputForUser(buildReadSummary(requests, result.results)));
  return toolResultOutput;
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
  } else if (r.mode_applied === "fileinfo") {
    hint = `<!-- File info for '${shortenPath(r.path)}' -->`;
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
