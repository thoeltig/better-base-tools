# better-base-tools

A collection of Claude Code plugins that provide more efficient base tools to reduce turns, duplicate tool calls, and token usage.

## Plugins

### batch_file_tools

Replaces individual `Read`, `Edit`, and `Write` calls with two multi-file MCP tools to cut round-trips and reduce context overhead. Includes:
- `batch_read`: multi-file reads with three modes — `compact` (collapsed, cheapest), `verbatim` (exact content, supports `offset`+`count` slicing), `fileinfo` (metadata + dependency refs)
- `batch_edit`: multiple ops across multiple files in one call — `replace`, `replace_all`, `insert_at_line`, `replace_range`, `write`
- Whitespace-normalized anchor matching and nearest-anchor error hints for failed edits
- Glob and directory expansion, search with context windows
- Measured impact: −58% tool calls, −46% input tokens, −45% session duration vs native tools

See [batch_file_tools README](./plugins/batch_file_tools/README.md) for detailed documentation.

### project-intel-tool

Persistent project knowledge base for directed file exploration. Scan once to generate semantic summaries of every file, then query before reading to avoid expensive, blind exploration. Includes:
- `query`: keyword search across filepaths, exports, imports and referenced files is available before any scan; after a scan the summary, role, technologies and search tags are also included in the search
- `scan`: AI analysis of changed/new files with topological batch ordering so dependencies are analyzed before dependents
- Two-layer model: structural data (size, line count, imports, exports, referenced files) always current without AI; semantic data (summary, role, technologies, search tags) populated by scan
- Git-based incremental scanning — only changed files re-analyzed; mtime fallback for non-git projects
- Session start hook that refreshes structural data and injects knowledge status into context every session
- Two scan modes: subagent (default, any harness) and MCP sampling (background analysis, no context pollution)

See [project-intel-tool README](./plugins/project-intel-tool/README.md) for detailed documentation.

## Installation

Each plugin can be installed independently through the Claude Code plugin marketplace.

## License

See root [LICENSE](./LICENSE) for details.

## Author

[Thore Höltig](https://github.com/thoeltig)
