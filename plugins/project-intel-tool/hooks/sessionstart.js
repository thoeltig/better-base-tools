#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
  respond('project-intel-tool: CLAUDE_PLUGIN_ROOT not set — plugin may not be installed correctly.');
  process.exit(0);
}

const distPath = path.join(pluginRoot, 'scripts', 'dist', 'sessionstart-knowledge-check.js');

if (!fs.existsSync(distPath)) {
  respond(
    'project-intel-tool: Hook script is not built. Run the following to fix:\n' +
    '  cd ' + path.join(pluginRoot, 'scripts') + ' && npm install && npm run build'
  );
  process.exit(0);
}

const result = spawnSync(process.execPath, [distPath], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf-8',
  stdio: ['inherit', 'pipe', 'pipe']
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 0);
