# better-base-tools

A collection of Claude Code plugins that provide more efficient base tools to reduce turns, duplicate tool calls, and token usage.

Claude Code sessions accumulate context fast — every native tool call appends its result to the context window, and every session starts blind into the project. These plugins address both: `batch_file_tools` cuts I/O round-trips by batching reads and edits; `project-intel-tool` builds a persistent project map so sessions start informed, not blind.

## Plugins

### batch_file_tools

Replaces individual `Read`, `Edit`, and `Write` calls with two multi-file MCP tools to cut round-trips and reduce context overhead. Includes:
- `batch_read` reads multiple files in one call using three modes: `compact` (collapsed whitespace, lowest token cost), `verbatim` (exact content, with `offset`+`count` slicing), and `fileinfo` (metadata and dependency refs).
- `batch_edit` applies multiple operations across multiple files in one call, supporting `replace`, `replace_all`, `insert_at_line`, `replace_range`, and `write`.
- Whitespace-normalized anchor matching keeps failed edits from requiring a re-read; nearest-anchor error hints pinpoint the correction.
- Indentation is normalized to 2-space on read by default for token efficiency; disable via env var when editing indentation directly.
- Glob and directory expansion with search and context windows for targeted reads.
- Measured impact: −58% tool calls, −46% effective input tokens, −45% session duration; the same call budget completes 2.4× more equivalent I/O work compared to native tools.

See [batch_file_tools README](./plugins/batch_file_tools/README.md) for detailed documentation.

### project-intel-tool

Persistent project knowledge base for directed file exploration. Structural data (sizes, imports, exports, file map) is available immediately without any scan; run scan once to add semantic summaries. Query before reading to orient without touching file content.
- `query` searches by keyword across filepaths, exports, imports, and referenced files without any prior scan. After a scan, summaries, roles, technologies, and search tags are also included.
- `scan` runs AI analysis on changed and new files, ordering batches topologically so dependencies are analyzed before dependents.
- A two-layer data model separates structural data (size, line count, imports, exports, referenced files), which is always current without AI, from semantic data (summary, role, technologies, search tags), which is populated by scan.
- Incremental scanning via git re-analyzes only changed files; filesystem mtime serves as a fallback for non-git projects.
- A session start hook refreshes structural data and injects knowledge status into the model's context on every session.
- Two scan modes are available: subagent (default, works in any harness) and MCP sampling (runs in the background without polluting the model's context).
- Committing `.knowledge/summaries.json` shares the knowledge base across teammates and sessions.
- Monorepo support aggregates knowledge across all sub-project knowledge bases automatically.
- Measured impact: exploration agents averaged ~577k subagent tokens per orientation; `query` replaces this with a single call at near-zero cost, and knowledge persists across sessions so orientation is paid only once.

See [project-intel-tool README](./plugins/project-intel-tool/README.md) for detailed documentation.

## How they work together

`project-intel-tool` eliminates the read-many-files orientation loop at session start: a single `query` call returns sizes, imports, refs, and summaries across the entire project without touching file content, so the model enters the task knowing which files are relevant and how large they are. `batch_file_tools` handles the work phase: `batch_read` reads only the identified files, bundled and targeted; `batch_edit` applies changes without any preceding read. Orientation front-loads into the first few turns; the remainder of the session is productive work rather than exploration. Tasks that previously required a full session to orient — and a second to execute — complete start-to-finish in one.

## Requirements

Node.js >= v22

## Installation

Each plugin can be installed independently through the Claude Code plugin marketplace.

## License

See root [LICENSE](./LICENSE) for details.

## Author

[Thore Höltig](https://github.com/thoeltig)
