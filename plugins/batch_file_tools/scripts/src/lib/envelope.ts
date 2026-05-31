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

export function formatReadContent(result: ReadOutput, requests: ReadonlyArray<ReadRequest>, addUserAudience: boolean): ToolContentResult[] {
  const toolResultOutput = result.results.map(readResultToBlock);
  if (addUserAudience) toolResultOutput.push(createToolOutputForUser(buildReadSummary(requests, result.results)));
  return toolResultOutput;
}

export function formatEditContent(result: EditOutput, files: ReadonlyArray<EditFile>, addUserAudience: boolean, dryRun: boolean | undefined): ToolContentResult[] {
  const ok = result.results.filter(r => r.status === "ok");
  const errors = result.results.filter(r => r.status === "error" || r.status === "partial");
  const skipped = result.results.filter(r => r.status === "skipped");

  if (errors.length === 0 && skipped.length === 0) {
    const label = ok.length === 1 ? shortenPath(ok[0]!.path) : `${ok.length} files`;
    const tag = dryRun ? "DRY RUN: batch_edit OK" : "batch_edit OK";
    const toolOutputNoErrors = [createToolOutputForAssistant(`<!-- ${tag} — ${label} -->`)];    
    if (addUserAudience) toolOutputNoErrors.push(createToolOutputForUser(buildEditSummary(files, result.results)));
    return toolOutputNoErrors;
  }

  const summaryParts: string[] = [];
  if (ok.length > 0) summaryParts.push(`${ok.length} OK`);
  if (errors.length > 0) summaryParts.push(`${errors.length} error${errors.length > 1 ? "s" : ""}`);
  if (skipped.length > 0) summaryParts.push(`${skipped.length} skipped`);

  const errorLines: string[] = [];
  const anchorBlocks: ToolContentResult[] = [];

  for (const r of errors) {
    const fileHeader = r.error
      ? `${shortenPath(r.path)} — ${r.error.reason}: ${r.error.message}`
      : `${r.path} (${r.status}):`;
    errorLines.push(fileHeader);

    for (let i = 0; i < r.ops.length; i++) {
      const op = r.ops[i]!;
      const idx = op.index ?? i;
      if (op.status === "error") {
        const tag = `  op ${idx}${op.type ? ` (${op.type})` : ""}`;
        let line = `${tag}: ${op.reason ?? "error"}`;
        if (op.hint?.next_action) line += ` — ${op.hint.next_action}`;
        if (op.hint?.match_lines?.length) line += ` (matches at lines ${op.hint.match_lines.join(", ")})`;
        errorLines.push(line);
        const anchor = op.hint?.nearest_anchor;
        if (anchor) {
          anchorBlocks.push(createToolOutputForAssistant(`<!-- op ${idx} nearest_anchor: ${shortenPath(r.path)} lines ${anchor.start_line}-${anchor.end_line} -->\n${anchor.content.replace(/\n$/, "")}`));
        }
      } else if (op.status === "skipped") {
        errorLines.push(`  op ${idx}: skipped`);
      }
    }
  }

  for (const r of skipped) {
    errorLines.push(`${shortenPath(r.path)} — skipped`);
  }

  const toolResultOutput = [
    createToolOutputForAssistant(`<!--\nbatch_edit — ${summaryParts.join(", ")}\n\n${errorLines.join("\n")}\n-->`),
    ...anchorBlocks,
  ];
  if (addUserAudience) toolResultOutput.push(createToolOutputForUser(buildEditSummary(files, result.results)));
  return toolResultOutput;
}

function readResultToBlock(r: ReadResult): ToolContentResult {
  let hint = "";
  if (r.error) {
    hint = `<!-- '${r.error.reason}' error reading file '${shortenPath(r.path)}' as '${r.mode_applied}': ${r.error.message} -->`;
  } else if (r.mode_applied === "fileinfo") {
    hint = `<!-- File info for '${shortenPath(r.path)}' -->`;
  } else if (r.match_count !== undefined) {
    hint = `<!-- Found ${r.match_count} match(es) in ${r.lines} lines of '${shortenPath(r.path)}' as '${r.mode_applied}' -->`;
  } else {
    const countPrefix = r.returned_lines !== r.lines ? `${r.returned_lines} of ` : "";
    const unit = r.lines === 1 ? "line" : "lines";
    hint = `<!-- Read ${countPrefix}${r.lines} ${unit} in file '${shortenPath(r.path)}' as '${r.mode_applied}' -->`;
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
