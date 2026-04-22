# better-base-tools — dev environment
This repo develops `batch_file_tools`, an MCP server at `plugins/batch_file_tools/` that provides batch-capable `batch_read` and `batch_edit` tools designed to reduce turns, tool calls, and tokens vs the built-in `Read`/`Edit`/`Write`.

## Tool preference (while developing this repo)
This is the **dogfooding environment** for the MCP. Prefer the MCP tools over the built-ins for every read/write/edit shorthand:
This applies to every task in this repo — research, debugging, implementation. Batch where possible: reading 3 files = 1 `batch_read` call, not 3 `Read` calls.
If the MCP is unavailable (build broken, registration missing), fall back to the built-ins and flag it to the user.

## What moves to a session-start hook for release
The directive above is an interim dev-environment nudge. When `batch_file_tools` ships as a distributable plugin, an on-install `SessionStart` hook will inject tool-preference guidance directly so end users don't need to edit `CLAUDE.md`. Refine tool descriptions at that point too.

## Build commands
From `plugins/batch_file_tools/`:
- `npm run build` — compile to `dist/`
- `npm test` — run vitest suite
- `npm run typecheck` — strict tsc, no emit
- `npm run inspect` — launch MCP Inspector against the built server

Rebuild (`npm run build`) after any `src/` change — the MCP loads `dist/index.js`.