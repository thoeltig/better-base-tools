#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

function respond(additionalContext) {
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  }) + '\n');
}

if (!pluginRoot) {
  respond('batch_file_tools: CLAUDE_PLUGIN_ROOT not set — plugin may not be installed correctly.');
  process.exit(0);
}

const distPath = path.join(pluginRoot, 'scripts', 'dist', 'index.js');

if (!fs.existsSync(distPath)) {
  respond(
    'batch_file_tools: MCP server is not built. Run the following to fix:\n' +
    '  cd ' + path.join(pluginRoot, 'scripts') + ' && npm install && npm run build'
  );
  process.exit(0);
}

respond(
  'Tool preference: Always use `batch_read` and `batch_edit` instead of the built-in Read, Edit, Write and Update tools.\n' +
  'Workflow: Plan which files you need and in what order. Bundle related reads into one `batch_read` call and related edits into one `batch_edit` call — fewer round-trips means less context noise and more room for the actual task.'
);
