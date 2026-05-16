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
const claudeMdPath = path.join(pluginRoot, 'CLAUDE.md');

if (!fs.existsSync(distPath)) {
  respond(
    'batch_file_tools: MCP server is not built. Run the following to fix:\n' +
    '  cd ' + path.join(pluginRoot, 'scripts') + ' && npm install && npm run build'
  );
  process.exit(0);
}

try {
  const content = fs.readFileSync(claudeMdPath, 'utf8');
  respond(content);
} catch (e) {
  respond('batch_file_tools: Could not read CLAUDE.md: ' + e.message);
}
