# Changelog

All notable changes to the project-intel-tool documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

## [1.1.0] - 2026-06-01

_Query freshness awareness and ref extraction improvements._

### Added

- **Analysis delta**: Query results now include `analysisDelta` (e.g. `+2 lines +50 chars`) on file entries when a file has been modified since its last semantic analysis, giving an at-a-glance signal of how much the content has drifted.
- **Semantic weight penalty**: Semantic match scores (purpose, summary, role, technologies) are scaled by the ratio of current to baseline file size. Factual fields (exports, imports, refs, path) are unaffected — heavily rewritten files rank lower on semantic matches but still surface on structural ones
- **Folder-level technologies**: Grouped query output now aggregates a deduplicated `technologies` list at the folder level

### Fixed

- **Line count off by one**: `lineCount` in structural data now correctly handles trailing newlines, matching the count returned by `fileinfo` mode in batch_file_tools
- **Extension-less file refs**: `parseText` now captures references to extension-less files (e.g. `LICENSE`) via markdown link syntax, consistent with batch_file_tools ref extraction

### Changed

- **`deleted` and `lastUpdated` removed from query output**: Both were redundant (`deleted` is always false since deleted files are excluded; `lastUpdated` is an internal timestamp superseded by `analysisDelta`)
- **`technologies` moved from per-file to folder-level in grouped output**

## [1.0.0] - 2026-05-29

_Stable release: Instruction clarity, scan accuracy, and display improvements._

### Fixed

- **Structural scan timestamp**: Structural scan no longer sets the last-update timestamp, which now exclusively indicates when the sampling/subagent workflow was last run

### Changed

- **Changed file count display**: Session start now shows changed file count only instead of the combined changed + unanalyzed total
- **unanalyzedFilesCount location**: Moved to project scanner to reduce redundant summary file reads
- **Redundant pre-scan merge removed**: Structural scan merge before subagent batches was redundant and is now removed
- **Subagent workflow instructions**: Simplified and made non-contradicting for cleaner agent guidance

### Improved

- **Filepath handling**: Cleaned up cross-platform path normalization throughout the codebase

## [0.6.0] - 2026-05-29

_Reference scope and session start reliability fixes._

### Fixed

- **File reference scope**: Refs stored in summaries now capture project-wide references instead of partial scope from the scan location
- **File existence check**: Validation now checks the file on disk (not just the git index) and normalizes path comparison between stored and checked paths
- **Session start status message**: Fixed string concatenation error in the status display

### Improved

- **Session start messaging**: More instructional output from the session start hook to guide users toward effective workflows
- **File map on session start**: File dependency map is now updated during session start for accurate reference tracking

## [0.5.0] - 2026-05-29

_Environment variable configuration for token budgets and path filtering._

### Added

- **Token budget configuration**: Min/max tokens per subagent and char-per-token rate configurable via environment variables
- **Include/exclude path configuration**: Scan include and exclude paths configurable via args or environment variables

### Changed

- **Env variable naming**: Renamed environment variables for consistency
- **Query always loads**: Query tool now always loads summaries fresh on each call
- **Max output increased**: Query result limit increased

## [0.4.0] - 2026-05-29

_Session start validation hook._

### Added

- **Session start wrapper script**: Validates that the plugin build exists before attempting the session start scan; provides an actionable error message if the build is missing

### Improved

- **Session start scan**: Refined behavior and output of the session start knowledge check

### Fixed

- **Batching tests**: Corrected failing batch builder unit tests

## [0.3.0] - 2026-05-28

_Subagent fallback workflow and batching improvements._

### Added

- **Subagent fallback workflow**: When the MCP harness doesn't support sampling, scan falls back to pre-written batch files executed by subagents

### Fixed

- **Sampling token limit**: Reduced max tokens per sampling request to 50k to prevent overrun

### Improved

- **Batching strategy**: Folder-affinity grouping and a minimum batch size ensure related files are analyzed together

## [0.2.0] - 2026-05-28

_Scan engine overhaul: reliability and correctness fixes._

### Fixed

- **Path resolution**: Root path and scanLocation validation now correctly resolve to absolute paths
- **Duplicate file map enrichment**: Removed a duplicate enriching pass in fileMap construction
- **Duplicate summary loading**: Eliminated redundant summary load on scan startup

### Improved

- **Scan blocking**: Restructured scan logic to reduce the duration of blocking operations
- **File map and sampling**: Improved data extraction and sampling coordination
- **Concurrent scan protection**: Lock logic added to handle overlapping scan calls safely

## [0.1.0] - 2026-05-27

_Initial release: Port from CLI tool to MCP server._

This version ports the project-intel tool from a slash-command CLI tool (originally developed in [claude-code-toolkit](https://github.com/thoeltig/claude-code-toolkit/tree/main/plugins/project-intel) at v1.6.1.0) to a native MCP server using `@modelcontextprotocol/sdk`. The original provided scan/query slash commands with semantic scoring and wave-based parallel processing.

### Added

- MCP server implementation using `@modelcontextprotocol/sdk`
- `scan` tool: Trigger semantic file analysis via MCP protocol
- `query` tool: Keyword-based ranked search against stored summaries
- `submit_analysis` tool: Endpoint for subagents to submit analysis results

### Changed

- Architecture: from slash-command CLI to MCP server (`McpServer` replacing deprecated `Server`)

### Fixed

- Removed hardcoded model name and summaries path from ignore patterns

[unreleased]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.1.0...HEAD
[1.1.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.0.0...ProjectIntelTools_v1.1.0
[1.0.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.6.0...ProjectIntelTools_v1.0.0
[0.6.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.5.0...ProjectIntelTools_v0.6.0
[0.5.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.4.0...ProjectIntelTools_v0.5.0
[0.4.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.3.0...ProjectIntelTools_v0.4.0
[0.3.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.2.0...ProjectIntelTools_v0.3.0
[0.2.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.1.0...ProjectIntelTools_v0.2.0
[0.1.0]: https://github.com/thoeltig/better-base-tools/releases/tag/ProjectIntelTools_v0.1.0
