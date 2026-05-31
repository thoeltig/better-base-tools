# better-base-tools

A collection of Claude Code plugins that provide more efficient base tools to reduce turns, duplicate tool calls, and token usage.

## Plugins

### batch_file_tools

Batch operations for reading and editing files with optimized performance. Includes advanced features like:
- Multi-file reads in a single call
- Flexible read modes (compact, verbatim, verbatim_numbered, fileinfo)
- Content-based search and line-number anchored edits
- Glob pattern support for batch operations

See [batch_file_tools README](./plugins/batch_file_tools/README.md) for detailed documentation.

### project-intel-tool

Persistent project knowledge base for directed file exploration. Scan once to generate semantic summaries of every file and directory, then query before reading to avoid blind exploration. Includes:
- Semantic scoring across purpose, summary, exports, imports, and technologies
- Per-file metadata (size, line count, imports, exports, inter-file refs) for efficient targeted reads
- Git-based incremental scanning — only changed files re-analyzed
- Session start hook that reports knowledge status and prompts re-scanning when files change
- Subagent fallback workflow for harnesses without MCP sampling support

See [project-intel-tool README](./plugins/project-intel-tool/README.md) for detailed documentation.

## Installation

Each plugin can be installed independently through the Claude Code plugin marketplace.

## License

See root [LICENSE](./LICENSE) for details.

## Author

[Thore Höltig](https://github.com/thoeltig)
