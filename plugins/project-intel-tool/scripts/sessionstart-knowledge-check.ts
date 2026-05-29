#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { getOrCreateSummaries } from './lib/summary-merger.js';
import { AdditionalContext, HookResponse, KNOWLEDGE_DIRECTORY, DEFAULT_SCAN_CONFIG, ScanConfig, ENV_INCLUDE_PATHS, ENV_EXCLUDE_PATHS } from './types.js';

function outputHookResponse(additionalContext: AdditionalContext): void {
  const response: HookResponse = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: JSON.stringify(additionalContext),
    },
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  const config: ScanConfig = {
    ...DEFAULT_SCAN_CONFIG,
    includePaths: (process.env[ENV_INCLUDE_PATHS] ?? '').split(',').filter(Boolean),
    excludePaths: (process.env[ENV_EXCLUDE_PATHS] ?? '').split(',').filter(Boolean),
  };

  const knowledgeDir = findKnowledgeDir(cwd);

  if (!knowledgeDir || !fs.existsSync(knowledgeDir)) {
    const potentialKnowledgeDir = knowledgeDir ?? path.join(cwd, KNOWLEDGE_DIRECTORY);
    try {
      const scanResult = await scanProject(cwd, potentialKnowledgeDir, config);
      const totalFiles = scanResult.filesToScan.length;
      outputHookResponse({
        severity: 'info',
        assistant_action: 'suggest_action',
        assistant_instruction: 'Inform the user no project knowledge exists. Mention how many files were detected and suggest calling the scan tool.',
        user_message: totalFiles > 0
          ? `No project knowledge found. ${totalFiles} file(s) detected. Call the scan tool to generate summaries.`
          : 'No project knowledge found. Call the scan tool to generate summaries.',
        filesDetected: totalFiles,
      });
    } catch {
      outputHookResponse({
        severity: 'info',
        assistant_action: 'suggest_action',
        assistant_instruction: 'Inform the user no project knowledge exists and suggest calling the scan tool.',
        user_message: 'No project knowledge found. Call the scan tool to generate summaries.',
      });
    }
    return;
  }

  const scanResult = await scanProject(cwd, knowledgeDir, config);
  const summaries = getOrCreateSummaries(knowledgeDir);

  const { totalFilesInKnowledge, numberOfFilesToScan } = scanResult.projectStats;

  const scanFilesSet = new Set(scanResult.filesToScan);
  let unanalyzedCount = 0;
  for (const [filePath, summary] of summaries.files) {
    if (!summary.deleted && !summary.summary && !summary.purpose && !scanFilesSet.has(filePath)) {
      unanalyzedCount++;
    }
  }

  const totalNeedsUpdate = numberOfFilesToScan + unanalyzedCount;
  const parts: string[] = [];
  if (numberOfFilesToScan > 0) parts.push(`${numberOfFilesToScan} file(s) changed`);
  if (unanalyzedCount > 0) parts.push(`${unanalyzedCount} file(s) without AI analysis`);

  const userMessage = totalNeedsUpdate > 0
    ? `${totalFilesInKnowledge} file summaries available, ${parts.join(', ')}. Call the scan tool to update.`
    : `${totalFilesInKnowledge} file summaries available. Use the query tool to search the project.`;

  outputHookResponse({
    severity: 'info',
    assistant_action: totalNeedsUpdate > 0 ? 'suggest_action' : 'inform_only',
    assistant_instruction: totalNeedsUpdate > 0
      ? 'Inform the user about detected file changes or missing AI analysis and suggest calling the scan tool.'
      : 'Inform the user that project knowledge is available for queries.',
    user_message: userMessage,
    filesNeedingUpdate: totalNeedsUpdate,
  });
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    outputHookResponse({
      severity: 'warning',
      assistant_action: 'inform_only',
      assistant_instruction: 'Knowledge check failed. Proceed normally.',
      user_message: 'Could not check project knowledge status.',
    });
    process.exit(0);
  });
