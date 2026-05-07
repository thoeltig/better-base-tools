# better-base-tools — dev environment
This repo develops `batch_file_tools`, an MCP server at `plugins/batch_file_tools/` that provides batch-capable `batch_read` and `batch_edit` tools designed to reduce turns and tool calls.

# Tool preference
You should always prefer the `batch_read` and `batch_edit` MCP tools over the built-in `Read`, `Edit`, `Update` and `Write` native tools. The MCP tools are designed to help you plan ahead and work with files more efficiently. The MCP tools provide you with different read modes which let you choose if you need file content as is or with line numbers for editing or compact for information. Also different edit ops let you do multiple modifications at the same time while you can choose which action or file should output how much information about the op result and if an error should stop following ops or not.

## How to interact with files
When you try to read, write or edit files ask yourselve which files do you need to read in full and which parts of files do you need as information. In which order do you need the files and if you can bundle multiple edits into one action. For example if you know you need to read two files for context, write a new file and edit one file you can do this with a single `batch_read` call and single `batch_edit` call instead of three build in reads, 1 write and mutliple edit calls. So planning ahead will reduce the amount you need to reason between each step and also reduce the noise in context from all these individual call / result entries leaving more space for the actual goal at hand.

## Build commands
From `plugins/batch_file_tools/`:
- `npm run build` — compile to `dist/`
- `npm test` — run vitest suite
- `npm run typecheck` — strict tsc, no emit
- `npm run inspect` — launch MCP Inspector against the built server

Rebuild (`npm run build`) after any `src/` change — the MCP loads `dist/index.js`.