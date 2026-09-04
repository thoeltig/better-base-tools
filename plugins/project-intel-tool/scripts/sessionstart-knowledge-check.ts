#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { scanProject, findKnowledgeDir, aggregateSubKnowledgeStats } from './lib/project-scanner.js';
import { HookResponse, KNOWLEDGE_DIRECTORY, DEFAULT_SCAN_CONFIG, ScanConfig, ENV_INCLUDE_PATHS, ENV_EXCLUDE_PATHS } from './types.js';
import { parseConfigArg } from './lib/config.js';

function outputHookResponse(systemMessage: string, additionalContext: string): void {
  const response: HookResponse = {
    continue: true,
    suppressOutput: false,
    systemMessage: systemMessage,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  const config: ScanConfig = {
    ...DEFAULT_SCAN_CONFIG,
    includePaths: parseConfigArg('include', ENV_INCLUDE_PATHS, '').split(',').filter(Boolean),
    excludePaths: parseConfigArg('exclude', ENV_EXCLUDE_PATHS, '').split(',').filter(Boolean),
  };

  const knowledgeDir = findKnowledgeDir(cwd);

  if (!knowledgeDir || !fs.existsSync(knowledgeDir)) {
    const potentialKnowledgeDir = knowledgeDir ?? path.join(cwd, KNOWLEDGE_DIRECTORY);
    const suggestionMessage = 'Suggest scanning the project to generate a file map which will help you find files and connections between files faster.';
    try {
      const scanResult = await scanProject(cwd, potentialKnowledgeDir, config);
      const totalFiles = scanResult.filesToScan.length;
      const { knowledgeBaseCount, totalEntries } = aggregateSubKnowledgeStats(scanResult.subKnowledge, cwd);

      let systemMessage: string;
      let additionalContext: string;
      if (knowledgeBaseCount > 0) {
        const dirWord = knowledgeBaseCount === 1 ? 'directory' : 'directories';
        systemMessage = `Project knowledge not yet generated in current folder but ${totalEntries} file summaries available across ${knowledgeBaseCount} sub knowledge ${dirWord}`;
        additionalContext = `Suggestion: Inform the user no project knowledge exists in the current folder, but ${totalEntries} file summaries are available via query across ${knowledgeBaseCount} sub knowledge ${dirWord}`;
      } else {
        systemMessage = 'Project knowledge not yet generated';
        additionalContext = 'Suggestion: Inform the user no project knowledge exists';
        if (totalFiles > 0) {
          const filesToScanMessagePart = ` but found ${totalFiles} file(s) to scan`;
          systemMessage += filesToScanMessagePart;
          additionalContext += filesToScanMessagePart;
        }
      }
      additionalContext += '. ' + suggestionMessage;
      outputHookResponse(systemMessage, additionalContext);
    } catch {
      outputHookResponse('Project knowledge not yet generated', suggestionMessage);
    }
    return;
  }

  const scanResult = await scanProject(cwd, knowledgeDir, config);
  const { totalFilesInKnowledge, changedFilesCount, unanalyzedFilesCount } = scanResult.projectStats;
  const { knowledgeBaseCount, totalEntries } = aggregateSubKnowledgeStats(scanResult.subKnowledge, cwd);

  const totalKnowledgeDirs = 1 + knowledgeBaseCount;
  let statusMessage = totalKnowledgeDirs > 1
    ? `${totalFilesInKnowledge + totalEntries} file summaries available across ${totalKnowledgeDirs} knowledge directories`
    : `${totalFilesInKnowledge} file summaries available`;
  if (changedFilesCount > 0) statusMessage += `, ${changedFilesCount} file(s) changed`;
  if (unanalyzedFilesCount > 0) statusMessage += `, ${unanalyzedFilesCount} file(s) without AI analysis`;

  const additionaContext = `You should always use the 'query' MCP tool to explore the project because it will provide you a token efficient overview of the project structure, file sizes and interconnection between the files. ` +
  `The result will also provide you a quick overview of the used technologies, imports and exports, role and description of each file.` +
  `The tool is designed to provide you an efficent way to know what files you need for a task without reading the full files.` +
  `\nFile map and structural information are always up to date, descriptions might need a reevaluation after file changes to check if the content still matches the summaries: ${statusMessage}`;
  outputHookResponse(statusMessage, additionaContext);
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    outputHookResponse('Knowledge check failed', 'Could not check project knowledge status. Most likely an issue with the MCP sever.');
    process.exit(0);
  });
