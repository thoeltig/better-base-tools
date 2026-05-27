#!/usr/bin/env node
/**SessionStart Hook: Check for project knowledge updates.
 *
 * Notifies user if project knowledge is available and if there are files needing update.
 * If no knowledge exists but files are present, suggests running /project-intel:scan.
 * Uses official Claude Code hook response schema with structured JSON in additionalContext.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import { ScanResult } from './lib/project-scanner';
import { AdditionalContext, HookResponse } from './types';

function outputHookResponse(systemMessage: string, additionalContext: AdditionalContext): void{ 
  const response: HookResponse = {
    continue: true,
    suppressOutput: false,
    systemMessage: systemMessage,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: JSON.stringify(additionalContext)
    }
  };

  console.log(JSON.stringify(response));
}

function outputSuggestionToRunInitialScan(): void{    
  const additionalContext: AdditionalContext = {
    severity: 'info',
    assistant_action: 'suggest_action',
    assistant_instruction:
      'Inform the user that project knowledge has not been generated yet and suggest running /project-intel:scan to generate it.',
    user_message:
      'No project knowledge found. Run /project-intel:scan to generate intelligent summaries of project files for fast searches.'
  };

  outputHookResponse('Project knowledge not yet generated', additionalContext);
}

function main(): void {
  try {
    // .knowledge exists, proceed with normal flow
    const ctxPath = path.join(__dirname, 'ctx.js');
    const scanOutput = execSync(`node "${ctxPath}" scan --calledFromHook=true`, {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const scanData: ScanResult = JSON.parse(scanOutput);

    // Check if error
    if (!scanData || !scanData.projectStats.knowledgeDir) {
      outputSuggestionToRunInitialScan();
      return;
    }

    const filesNeedingUpdate = scanData.projectStats.numberOfFilesToScan || 0;

    // Generate message
    let userMessage = `You can use /project-intel:query to find relevant information about ${scanData.projectStats.totalFilesInKnowledge} files in the current project. This is a semantic and token efficient query which you can do before exploring the project to get a better understanding of where to search or to provide a quick summary.`;
    let assistantAction = 'inform_only';
    let systemMessage = 'Project knowledge is up to date';

    if (filesNeedingUpdate > 0) {
      userMessage += `\n\n${filesNeedingUpdate} files need update since last knowledge scan. Run /project-intel:scan to update.`;
      assistantAction = 'suggest_action';
      systemMessage = `Project knowledge needs update: ${filesNeedingUpdate} files detected`;
    }

    const additionalContext: AdditionalContext = {
      severity: 'info',
      assistant_action: assistantAction,
      assistant_instruction:
        filesNeedingUpdate > 0
          ? 'Inform the user about detected changes and suggest running /project-intel:scan.'
          : 'Inform the user that project knowledge is available for queries.',
      user_message: userMessage,
      filesNeedingUpdate
    };

    outputHookResponse(systemMessage, additionalContext);
  } catch {
    outputSuggestionToRunInitialScan();
  }
}

main();
