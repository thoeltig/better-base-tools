# Changelog

All notable changes to the project-intel plugin documented here.

Format: [Common Changelog](https://common-changelog.org) + [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

## [1.6.1.0] - 2026-03-04

### Fix

- **Duplicate entries in scan output**: The same files were listed in multiple batches which results in unecessary subagents and file summarization processes. Now only unique entries are processed.

## [1.6.0.0] - 2026-03-01

### Improved

- **Scan output batching**: Files are now pre-batched in the scanner (8 files per batch) instead of requiring the model to create batches. Reduces model overhead and simplifies slash command implementation.

### Changed

- **Scan.json structure**: `filesToScan` is now an array of arrays (batches) instead of a flat array. Each batch contains ~8 files for concurrent processing.

## [1.5.2.0] - 2026-02-16

### Fixed

- **Scan output in slash command**: Adjusted the example scan output of the subagents in `/scan`. Sometimes the main agent provides the scan output as an example to the subagents which results in the wrong output format because the invocation prompt takes priority over the subagent prompt.

## [1.5.1.0] - 2026-02-06

### Fixed

- **Partial summaries merge**: Fixed error when knowledgeDir argument wasn't provided on merge. Problem was the usage of the undefined argument value after already locating the actual knowledge directory.
- **Remaining old record structure removed**: Fixed remaining usages of old files and directories as record structure and use map structure instead. Now also returns correct total sizes on scan / mergen and delete obsolete directory entries properly.

## [1.5.0.0] - 2026-02-06

_Refactoring and bug fixes for code organization and discovery logic._

### Improved

- **Code organization**: Extracted constants and types into dedicated types.ts file for better maintainability

### Fixed

- **Knowledge directory discovery**: Added early exit when location/process directory is higher in directory structure than found .knowledge directory
- **calledFromHook early exit**: Fixed unused calledFromHook early exit logic
- **Git detection**: Fixed use git logic to check for git repo in location instead of only checking if git is installed
- **findKnowledgeDir logic**: Simplified file system search logic for better reliability

## [1.4.0.0] - 2026-02-06

_Stability improvements: Bug fixes for entry ordering, merge logic, ignore patterns, and timestamp handling._

### Fixed

- **Entry ordering**: Fixed reorder problem when loading and saving entries from summaries
- **Merge logic**: Removed obsolete entry deletion in merge (already handled by scan)
- **Ignore patterns**: Internal ignore logic now properly includes dotfiles with selective filtering for build/cache directories on top of gitignore rules
- **Summary lookup**: Fixed lookup map building when merging scan results
- **Timestamp comparison**: Fixed file modification date comparison for accurate staleness detection

## [1.3.0.0] - 2026-02-05

_Query optimization: Better output structure, per-file technologies for detailed analysis, and improved default behavior._

### Added

- **Per-file technologies tracking**: Each file now captures its technologies (TypeScript, Python, JSON, etc.) during scan, enabling granular technology matching in queries
- **Improved query documentation**: `--format` parameter now clearly explains when to use grouped vs flat output with use-case descriptions

### Improved

- **Query output structure**:
  - Removed redundant `path` field from grouped format (now uses `fileName` + `folderPath` to eliminate duplication)
  - Removed `lastUpdated` from results (now irrelevant with SessionStart hook showing staleness)
  - Flat format includes per-file technologies for detailed cross-file comparisons
- **Default query format**: Changed to `grouped` (hierarchical organization by directory) as default, providing better architectural context
- **Query efficiency**: Eliminated redundant data in grouped format results, reducing output size and token overhead
- **Result clarity**: Flat format now shows file-level technologies for better understanding of implementation details

### Changed

- **Query default behavior**: `/query` now returns grouped results by default (use `--format=flat` for flat list)
- **Query parameter documentation**: Clearer guidance on when to use grouped (subsystem exploration) vs flat (cross-module comparisons)

## [1.2.0.0] - 2026-02-02

_Automatic session notifications and intelligent knowledge maintenance with deletion cleanup and dynamic directory discovery._

### Added

- **SessionStart hook**: Automatic notification on session start showing:
  - Total files available for querying in current project knowledge
  - Number of files needing update (new + modified since last scan)
  - Suggestion to run `/scan` if no knowledge exists for the project
  - Suggestion to run `/scan` to update when changes are detected
- **Automatic file deletion cleanup**: Files removed from scan location are now automatically deleted from summaries
- **Automatic directory cleanup**: Empty directories are automatically removed from summaries when all their files are deleted
- **Filesystem modification date detection**: Filesystem scanning now checks file modification times to detect new, modified, and deleted files (parity with git-based detection)
- **Dynamic knowledgeDir discovery**: Intelligent fallback chain for finding `.knowledge` directory:
  1. Use explicitly provided `--knowledgeDir` argument (if specified)
  2. Search from provided scan/query location (if location differs from cwd)
  3. Search from current working directory (process location)
  - Eliminates need to always specify `--knowledgeDir` for same-directory scans

### Improved

- **Knowledge maintenance**: Summaries stay accurate automatically - deleted and empty entries cleaned up
- **Cross-platform consistency**: Filesystem-based scanning now detects changes identically to git-based scanning (new/modified/deleted)
- **Ease of use**: No need to remember or repeatedly specify `--knowledgeDir` when scanning from project root
- **Session workflow**: Users immediately see project knowledge status without manual checks

## [1.1.0.0] - 2026-01-16

_Performance enhancement: Git-based incremental scanning reduces file processing by 80-95% on subsequent scans._

### Added

- Git integration for incremental scanning: Only re-analyze files modified since last scan
- Automatic git tracking detection: Uses `git ls-files` when available, falls back to filesystem walk
- Modification timestamp tracking from git history for accurate staleness detection

### Improved

- Scan performance and token usage by only scanning the files modified since last scan
- Slash command context: Removed unnecessary information from `/scan` and `/query` command to reduce model context bloat and use less tokens

## [1.0.0.0] - 2026-01-14

_First release: Lightweight reconnaissance system for directed code exploration._

### Added

- `/scan` command: Generate semantic summaries of project files and directories (one-time setup)
- `/query` command: Search summaries by semantic relevance before reading files
- Semantic scoring system matching on purpose, summary, exports/imports, technologies, and path
- Wave-based parallel processing: Max 10 concurrent agents for large projects
- Persistent storage: `.knowledge/summaries.json` survives across sessions
- Directory and file summary generation with purpose, role, exports, imports, and technologies tracking
- File modification timestamp tracking for staleness detection
- Scope filtering: Limit queries to specific directories with `--scope` parameter
- Result limiting: Control query results with `--max` parameter
- Incremental updates: Re-scan merges new summaries with existing knowledge
- Best practices guide for maintenance strategy and query approaches
- Performance characteristics: Cost estimates for projects of different sizes
- Troubleshooting guide with common issues and solutions
- Comparison to alternatives: vs. Explore agent, Grep/Glob, direct file reading
- Design decision documentation: Why persistent storage, wave-based processing, semantic scoring, query-first workflow, and user-managed staleness
- Support for semantic matching on conceptual terms, not just keywords
- Project structure guidance: When to use project-intel, when to skip it, breakeven analysis
- Applicability scope: Best fit for mid to larger projects (25+ files), team projects, multi-session work

[unreleased]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.6.1.0...HEAD
[1.6.1.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.6.0.0...ProjectIntel_v1.6.1.0
[1.6.0.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.5.2.0...ProjectIntel_v1.6.0.0
[1.5.2.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.5.1.0...ProjectIntel_v1.5.2.0
[1.5.1.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.5.0.0...ProjectIntel_v1.5.1.0
[1.5.0.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.4.0.0...ProjectIntel_v1.5.0.0
[1.4.0.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.3.0.0...ProjectIntel_v1.4.0.0
[1.3.0.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.2.0.0...ProjectIntel_v1.3.0.0
[1.2.0.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.1.0.0...ProjectIntel_v1.2.0.0
[1.1.0.0]: https://github.com/thoeltig/claude-code-toolkit/compare/ProjectIntel_v1.0.0.0...ProjectIntel_v1.1.0.0
[1.0.0.0]: https://github.com/thoeltig/claude-code-toolkit/releases/tag/ProjectIntel_v1.0.0.0