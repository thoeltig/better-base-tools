#!/usr/bin/env node
import * as fs from 'fs';
import { scanProject, findKnowledgeDir } from './lib/project-scanner.js';
import { AdditionalContext, HookResponse } from './types.js';

function outputHookResponse(systemMessage: string, additionalContext: AdditionalContext): void {
  const response: HookResponse = {
    continue: true,
    suppressOutput: false,
    systemMessage,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: JSON.stringify(additionalContext),
    },
  };
  console.log(JSON.stringify(response));
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const knowledgeDir = findKnowledgeDir(cwd);

  if (!knowledgeDir || !fs.existsSync(knowledgeDir)) {
    outputHookResponse('No project knowledge found', {
      severity: 'info',
      assistant_action: 'inform_only',
      assistant_instruction: 'Inform the user no project knowledge exists yet. They can call the scan tool to generate summaries.',
      user_message: 'No project knowledge found. Use the scan tool to generate file summaries.',
    });
    return;
  }

  const scanResult = await scanProject(cwd, knowledgeDir);
  const { totalFilesInKnowledge, numberOfFilesToScan } = scanResult.projectStats;

  const needsUpdate = numberOfFilesToScan > 0;
  const userMessage = needsUpdate
    ? `${totalFilesInKnowledge} file summaries available, ${numberOfFilesToScan} file(s) need update. Call the scan tool to update.`
    : `${totalFilesInKnowledge} file summaries available. Use the query tool to search the project.`;

  outputHookResponse(
    needsUpdate
      ? `Project knowledge needs update: ${numberOfFilesToScan} file(s) changed`
      : 'Project knowledge up to date',
    {
      severity: 'info',
      assistant_action: needsUpdate ? 'suggest_action' : 'inform_only',
      assistant_instruction: needsUpdate
        ? 'Inform the user about detected file changes and suggest calling the scan tool.'
        : 'Inform the user that project knowledge is available for queries.',
      user_message: userMessage,
      filesNeedingUpdate: numberOfFilesToScan,
    }
  );
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    outputHookResponse('Project knowledge check failed', {
      severity: 'warning',
      assistant_action: 'inform_only',
      assistant_instruction: 'Knowledge check failed. Proceed normally.',
      user_message: 'Could not check project knowledge status.',
    });
    process.exit(0);
  });
