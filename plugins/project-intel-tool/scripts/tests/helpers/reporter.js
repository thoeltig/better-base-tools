import { basename } from "node:path";
import { readFileSync } from "node:fs";

export default async function* reporter(source) {
  const failures = [];
  let passed = 0;
  let skipped = 0;

  for await (const event of source) {
    const isSuite = event.data?.details?.type === "suite";
    if (isSuite) continue;
    if (event.type === "test:pass") passed++;
    else if (event.type === "test:skip" || event.type === "test:todo") skipped++;
    else if (event.type === "test:fail") failures.push(event.data);
  }

  const parts = [];
  if (passed) parts.push(`✓ ${passed} passed`);
  if (skipped) parts.push(`~ ${skipped} skipped`);
  if (failures.length) parts.push(`✖ ${failures.length} failed`);
  yield parts.join("  ") + "\n";

  if (!failures.length) return;

  const fileCache = new Map();

  for (const { name, file, details } of failures) {
    const cause = details?.error?.cause;
    const loc = cause ? testFileLine(cause.stack ?? "") : null;

    let fileAndLine = basename(file ?? "");
    let sourceLine = null;
    if (loc && loc.length > 2) {
      const lineNum = parseInt(loc[1]);
      if (lineNum) {
        sourceLine = getLine(fileCache, file, lineNum);
        fileAndLine = `${loc[0]}:${loc[1]}-${loc[2]}`;
      }
    }

    yield `\n✖  ${name} (${fileAndLine})\n`;
    if (sourceLine) yield `\`${sourceLine.trim()}\`\n`;
    if (cause?.actual !== undefined) yield `returned: ${fmt(cause.actual)}\n`;
    else if (details?.error?.message) yield `error: ${details.error.message}\n`;
  }
}

function getLine(cache, filePath, lineNum) {
  if (!cache.has(filePath)) {
    try {
      cache.set(filePath, readFileSync(filePath, "utf8").split("\n"));
    } catch {
      cache.set(filePath, null);
    }
  }
  return cache.get(filePath)?.[lineNum - 1] ?? null;
}

function testFileLine(stack) {
  for (const line of stack.split("\n")) {
    const m = line.match(/([^()\s]+\.test\.[tj]sx?):[\d]+:[\d]+/);
    if (m) {
      const parts = m[0].split(":");
      return [basename(parts[0] ?? ""), parts[1], parts[2]];
    }
  }
  return null;
}

function fmt(v) {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}
