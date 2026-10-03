#!/usr/bin/env node
// Stop hook: refreshes structural data (imports, exports, sizes) of changed files. Never reports to the model.
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { getHookScanConfig } from './lib/config.js';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const knowledgeDir = findKnowledgeDir(cwd);
  if (!knowledgeDir) return;
  await scanProject(cwd, knowledgeDir, getHookScanConfig());
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[project-intel] structure refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(0);
  });
