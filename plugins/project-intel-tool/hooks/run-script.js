#!/usr/bin/env node
'use strict';

// Runs a built hook script from scripts/dist with the hook's cwd, env and stdin.
// Usage: run-script.js <script-name> [<HookEventName>]
// With a hook event name, setup problems reach the model as that event's additionalContext; otherwise only stderr.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const [scriptName, reportEvent] = process.argv.slice(2);

function reportProblem(message) {
  const text = 'project-intel-tool: ' + message;
  if (!reportEvent) {
    process.stderr.write(text + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: reportEvent,
      additionalContext: text
    }
  }) + '\n');
}

if (!scriptName) {
  reportProblem('run-script.js called without a script name.');
  process.exit(0);
}

if (!pluginRoot) {
  reportProblem('CLAUDE_PLUGIN_ROOT not set — plugin may not be installed correctly.');
  process.exit(0);
}

const distPath = path.join(pluginRoot, 'scripts', 'dist', scriptName + '.js');

if (!fs.existsSync(distPath)) {
  reportProblem(
    'Hook script is not built. Run the following to fix:\n' +
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
