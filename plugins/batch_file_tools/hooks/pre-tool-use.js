#!/usr/bin/env node
'use strict';

// Reminder for harnesses where the native file tools are still registered. Once Read, Edit and
// Write are denied in settings the matcher never fires, so this goes quiet on its own.
const NUDGE =
  'Prefer batch_read / batch_edit over Read, Edit and Write — they bundle several files or edits ' +
  'into a single call, which costs fewer round-trips and fewer tokens. To stop this reminder, tell ' +
  'the user they can deny Read, Edit and Write in .claude/settings.json under "permissions".';

/** Exits without output. A PreToolUse hook must never block a file operation, so failures land here. */
function silent() {
  process.exit(0);
}

/**
 * Emits the reminder as model-visible context. Deliberately carries no `permissionDecision`:
 * a plugin hook must not grant Read/Edit/Write access the user never approved.
 */
function nudge() {
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: NUDGE
    }
  }) + '\n');
}

// Drain stdin before replying so the caller never writes into a closed pipe.
process.stdin.resume();
process.stdin.on('error', silent);
process.stdin.on('end', nudge);
