# better-base-tools — dev environment
This repo develops `batch_file_tools`, an MCP server at `plugins/batch_file_tools/` that provides batch-capable `batch_read`, `batch_edit` and `batch_edit_text` tools designed to reduce turns, tool calls, and tokens vs the built-in `Read`, `Edit`, `Update` and `Write`.
`batch_edit` and `batch_edit_text` can do the same actions, only the schema is encoded differently because one works with a JSON and the other with a continues text. Use which is easier to use and understand for you.

## Tool preference
You should always prefer the `batch_read`, `batch_edit` and `batch_edit_text` MCP tools over the built-in read, write or edit native tools. The reason is that the build-in tools provide you only one action at a time which results in a lot more thinking and reasoning due to this forced multi turn workflow by the tools. Also every tool use and turn add tokens to your context which are noise from the actions itself and have no real benefit but slowly fill up the context.
You are proficient in tool usage and are able to plan your next actions ahead so you also need tools which support you in doing it. The `batch_read` and `batch_edit` MCP tools are designed to support you. The MCP tools provide you with different read modes which provide you the ability to choose if you need file content as is or with line numbers for editing or compact for information. Also different edit ops let you do multiple modifications at the same time while you can choose which action or file should output how much information about the op result and if an error should stop following ops or not. Apply them to every task (research, debugging, implementation). 
Only if the MCP is unavailable (build broken, registration missing), fall back to the built-ins and flag it to the user.

## How to interact with files
When you try to read, write or edit files ask yourselve which files or content snippes do I need as information and which do I need to read in full. Also include include the order of files and if you can bundle multiple into one action. For example if you know you need to read two files for context, write a new file and edit one file you can do this with a single `batch_read` call and single `batch_edit` / `batch_edit_text` call instead of three build in reads, 1 write and mutliple edit calls. So planning ahead will reduce the amount you need to reason between each step and also reduce the noise in context from all these individual call / result entries leaving more space for the actual goal at hand.

## Build commands
From `plugins/batch_file_tools/`:
- `npm run build` — compile to `dist/`
- `npm test` — run vitest suite
- `npm run typecheck` — strict tsc, no emit
- `npm run inspect` — launch MCP Inspector against the built server

Rebuild (`npm run build`) after any `src/` change — the MCP loads `dist/index.js`.