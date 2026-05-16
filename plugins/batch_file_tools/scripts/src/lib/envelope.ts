import type {
  EditOutput,
  ReadOutput,
  ReadResult,
} from "../types.js";

export interface TextBlock {
  type: "text";
  text: string;
}

export function formatReadContent(result: ReadOutput): TextBlock[] {
  return result.results.map(readResultToBlock);
}

export function formatEditContent(result: EditOutput, dryRun?: boolean): TextBlock[] {
  const ok = result.results.filter(r => r.status === "ok");
  const errors = result.results.filter(r => r.status === "error" || r.status === "partial");
  const skipped = result.results.filter(r => r.status === "skipped");

  if (errors.length === 0 && skipped.length === 0) {
    const label = ok.length === 1 ? ok[0]!.path : `${ok.length} files`;
    const tag = dryRun ? "DRY RUN: batch_edit OK" : "batch_edit OK";
    return [{ type: "text", text: `<!-- ${tag} — ${label} -->` }];
  }

  const summaryParts: string[] = [];
  if (ok.length > 0) summaryParts.push(`${ok.length} OK`);
  if (errors.length > 0) summaryParts.push(`${errors.length} error${errors.length > 1 ? "s" : ""}`);
  if (skipped.length > 0) summaryParts.push(`${skipped.length} skipped`);

  const errorLines: string[] = [];
  const anchorBlocks: TextBlock[] = [];

  for (const r of errors) {
    const fileHeader = r.error
      ? `${r.path} — ${r.error.reason}: ${r.error.message}`
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
          anchorBlocks.push({
            type: "text",
            text: `<!-- op ${idx} nearest_anchor: ${r.path} lines ${anchor.start_line}-${anchor.end_line} -->\n${anchor.content.replace(/\n$/, "")}`,
          });
        }
      } else if (op.status === "skipped") {
        errorLines.push(`  op ${idx}: skipped`);
      }
    }
  }

  for (const r of skipped) {
    errorLines.push(`${r.path} — skipped`);
  }

  return [
    { type: "text", text: `<!--\nbatch_edit — ${summaryParts.join(", ")}\n\n${errorLines.join("\n")}\n-->` },
    ...anchorBlocks,
  ];
}

function readResultToBlock(r: ReadResult): TextBlock {
  let hint = "";
  if (r.error) {
    hint = `<!-- '${r.error.reason}' error reading file '${r.path}' as '${r.mode_applied}': ${r.error.message} -->`;
  } else if (r.mode_applied === "fileinfo") {
    hint = `<!-- File info for '${r.path}' -->`;
  } else if (r.match_count !== undefined) {
    hint = `<!-- Found ${r.match_count} match(es) in ${r.lines} lines of '${r.path}' as '${r.mode_applied}' -->`;
  } else {
    const countPrefix = r.returned_lines !== r.lines ? `${r.returned_lines} of ` : "";
    const unit = r.lines === 1 ? "line" : "lines";
    hint = `<!-- Read ${countPrefix}${r.lines} ${unit} in file '${r.path}' as '${r.mode_applied}' -->`;
  }
  return { type: "text", text: `${hint}\n${r.content ?? ""}` };
}
