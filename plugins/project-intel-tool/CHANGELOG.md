# Changelog

All notable changes to the project-intel-tool documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)  
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

## [Unreleased]

## [1.5.0] - 2026-09-05

### Added
- **`project-intel-analyst` agent** (`agents/project-intel-analyst.md`) — purpose-built analysis subagent for the default scan mode, replacing a generic subagent. Pins `model: haiku`, restricts `tools` to `Read`, `batch_read` and `submit_analysis`, and owns the analysis rules (read the batch file once, never open the listed source files, submit, reply `Done`). `scan`'s returned instruction now names `subagent_type: "project-intel-analyst"` instead of describing model and behaviour in prose.
- **Read capacity check at session start** (`lib/config-check.ts`) — compares the analysis batch size against the output cap of every read path the analysis subagent has, using the configured value where set and the documented default otherwise. On a mismatch the hook appends a warning to `additionalContext` naming the keys to raise and the batch size to fall back to — a batch over the cap is truncated silently, so the subagent would summarise files whose content it never received.
  - `Read` is capped by `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`. `batch_read` is capped by the harness and by `BATCH_TOOLS_MAX_OUTPUT_TOKENS`; for the harness limit, `anthropic/maxResultSizeChars` in `BATCH_TOOLS_READ_META` **replaces** `MAX_MCP_OUTPUT_TOKENS` for that tool rather than combining with it, so the check does not advise raising an env var Claude Code ignores once the annotation is present.
  - All comparisons are made in characters. The caps do not share a unit — `anthropic/maxResultSizeChars` is already characters, `BATCH_TOOLS_MAX_OUTPUT_TOKENS` is converted by `batch_file_tools` with `BATCH_TOOLS_CHARS_PER_TOKEN`, and the batch budget is a token estimate converted with `PROJECT_INTEL_TOOL_CHARS_PER_TOKEN` — so comparing raw token counts would silently mix ratios that need not match. Advice is phrased in each key's own unit.

### Changed
- **Batch files no longer carry behavioural instructions** — `writeBatchFiles` passes an empty `action` to `buildPrompt`, so the file holds only the output schema, context summaries and file content. Sampling mode is unaffected: `runSampling` still injects its instruction into the sampling call, since it has no agent definition to carry it.
- **Include/exclude path parsing is resolved in one place** — `getIncludePaths()` and `getExcludePaths()` in `lib/config.ts` replace the identical `parseConfigArg(...).split(',').filter(Boolean)` pair that `index.ts` and `sessionstart-knowledge-check.ts` each carried, so the hook and the MCP server can no longer drift on how the same setting is read. The names they parse (`ARG_INCLUDE_PATHS`, `ARG_EXCLUDE_PATHS`, `ENV_INCLUDE_PATHS`, `ENV_EXCLUDE_PATHS`) are declared in `types.ts`.
- **`ENV_MAX_BATCH_TOKENS` and `ENV_CHARS_PER_TOKEN` added to `types.ts`** — `PROJECT_INTEL_TOOL_MAX_BATCH_TOKENS` is now read by both `index.ts` and the new capacity check, so it needs a single declaration. Settings parsed only in `index.ts` keep their inline literals. Env names external to this server (`CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS`, `BATCH_TOOLS_*`) stay in `lib/config-check.ts` — they are caps to fit inside, not settings this server owns.

### Fixed
- README requirements listed `zod 3.25.76` and `vitest 4.1.5`; actual dependencies are `zod 4.4.3` with tests on the built-in `node:test` runner (Vitest was dropped in 1.4.4).

## [1.4.9] - 2026-07-02

### Added

- **Session start reports nested sub-knowledge stats** — `aggregateSubKnowledgeStats` in `project-scanner.ts` recursively walks each knowledge base's stored `subKnowledge` refs (mirroring `query`'s aggregation) and counts non-deleted files across the full nested tree. When a local knowledge base exists, its status message folds the nested total in: `648 file summaries available across 3 knowledge directories` (falls back to the plain `N file summaries available` when there is no nested knowledge). When no local knowledge base exists yet but nested sub-projects have one, the message becomes `Project knowledge not yet generated in current folder but 619 file summaries available across 2 sub knowledge directories` instead of the plain "not yet generated" — so the model knows there is data to query instead of assuming none exists.

## [1.4.8] - 2026-07-02

### Fixed

- Improve the subagent instructions to reduce unnecessary tool uses

## [1.4.7] - 2026-07-01

### Fixed

- **`findKnowledgeDir` no longer adopts a nested sub-project's `.knowledge` dir** — it previously searched recursively down through subfolders and used the first `.knowledge/summaries.json` found as if it were the current location's own knowledge base; it now only recognizes a knowledge dir at the exact scanned location, falling back to creating a fresh one there when none exists.
- **Sub-project directories are now excluded from git-based scans** — `getFilesFromGit` had no notion of nested `.knowledge` dirs, so every file under a sub-project was proposed as "new" and merged into whichever knowledge base `findKnowledgeDir` happened to pick; `scanProject` now runs sub-knowledge discovery up front and excludes discovered sub-project directories from both the git-based and filesystem-based file listings.
- **`query` aggregates the full nested sub-knowledge tree, even without a top-level summary** — aggregation previously required an existing top-level `.knowledge/summaries.json` that had already recorded sub-project refs, and only reached one level deep, so sitting above several independent (or deeply nested) sub-project knowledge bases returned nothing or missed grandchildren; `query` now walks each base's stored `subKnowledge` refs recursively to any depth (cycle-safe, with accumulated project-relative paths), and discovers the first level directly from the filesystem when no top-level base exists yet.

### Added

- `discoverSubKnowledge(location, projectRoot, excludeAbsPaths)` in `project-scanner.ts` — finds nested `.knowledge/summaries.json` directories without descending into them; used by `scanProject` (to exclude sub-project files from the parent scan) and by the `query` tool (to seed the first level of aggregation before a top-level scan exists; deeper levels are followed from each base's stored `subKnowledge` refs).

## [1.4.6] - 2026-06-30

### Changed

- **`PROJECT_INTEL_TOOL_MAX_BATCH_TOKENS` default increased `50000` → `75000`** — reduces the number of sampling calls for medium-to-large projects; update `DEFAULT_SCAN_CONFIG.maxTokensPerBatch` accordingly.
- **`PROJECT_INTEL_TOOL_MCP_PROGRESS` removed** — MCP progress notifications now always fire during sampling (safe no-op when the harness does not support the capability, matching `batch_file_tools` behaviour). The `PROJECT_INTEL_TOOL_MCP_PROGRESS` env var and `--mcp-progress` arg are no longer recognised.

## [1.4.5] - 2026-06-30

### Changed

- **C# export capture** — `parseCSharp` now extracts public/internal methods (`CS_MEMBER_RE`, `\(` terminator) and public/internal consts (`CS_CONST_RE`) in addition to type declarations (class, struct, record, enum, interface); fields and properties are excluded to reduce cross-reference noise; negative lookahead in `CS_MEMBER_RE` prevents re-capturing type declaration names already handled by `CS_TYPE_RE`
- **C# import cross-referencing** — `buildFileMap` caches C# file content and runs a post-pass via `resolveCSImports`; for each file, candidate source files are scoped to those whose `namespace` declaration matches an existing `using` directive; the file content is then scanned for exported names (min 5 chars) from that candidate set; names exported by more than one candidate are skipped as too generic; matching names are added as resolved file-path imports alongside the existing namespace-only `using` entries; adds `CS_NAMESPACE_RE` constant for namespace extraction

## [1.4.4] - 2026-06-15

### Added

- `tests/helpers/reporter.js` — custom streaming reporter with compact, LLM-optimised output: summary header (`✓ N passed  ✖ N failed`), failing test name with `file:line-col`, inline source line in backticks, and `returned:` value
- `tests/helpers/expect.ts` — `expect()` wrapper around `node:assert/strict` with a Vitest-compatible API to reduce necessary changes to existing tests

### Changed

- Replaced Vitest with Node.js built-in `node:test` runner — removes `vitest` dev dependency and `vitest.config.ts`, add `tsx` and `esbuild` for TypeScript execution; all 6 test files updated
- Updated `zod` to `4.4.3`

## [1.4.3] - 2026-06-07

### Added

- **Token savings documentation** — added "Token Savings vs Exploration Agents" section to README with per-lookup cost comparison between `query` and Explore subagents, measured across sessions on a 68-file project and a larger Angular project

### Changed

- **`imports` structure** — changed from `string[]` (flat list of package or file names) to `Record<string, string[]>` (source path or package name → list of imported names). For TypeScript/JavaScript, named, default, namespace, and `import type` specifiers are all captured per source. For C#, namespace keys map to empty arrays. Dynamic `import()`, `require()`, and bare side-effect local imports go to `refs` instead of `imports` since they carry no named bindings.
- **Import scoring in `query`** — source path or package name match now scores +4; imported name match scores +3 as a separate signal (previously all import matches scored +4 flat)
- **`query` imports label rendering** — package names (no file extension) now render as-is; only local file paths use `basename()` shortening. Fixes ambiguous `sdk` label when multiple scoped packages share the same basename.
- **Batch clustering** — replaced folder-affinity topo-layer sort with cohesion-based union-find clustering: files connected by intra-scan imports/refs or by a shared already-summarized dependency form a component; files within each component are topo-sorted (deps first); components are packed into batches by token budget. Oversized components split in topo order.
- **Batch prompt structure** — action instruction moved to immediately after the output schema (before context and files); context section changed to `<context path="..." referenced_by="file1,file2">\nsummary\n</context>` XML format; file tags extended with `imports="key: name1, name2 | ..."` attribute listing intra-batch and context-file imports per file.
- **`minBatchTokens` removed** — `ScanConfig`, `DEFAULT_SCAN_CONFIG`, and the `--min-batch-tokens` / `PROJECT_INTEL_TOOL_MIN_BATCH_TOKENS` config option are removed; cohesion clustering packs components greedily so the layer-boundary flush threshold has no equivalent role.
- **`.js` → `.ts` import resolution** — `resolveImport` in `file-map.ts` now strips the existing extension and retries with TypeScript extensions, resolving ESM-style `.js` imports to their `.ts` source files. Fixes missing import edges and context entries for TypeScript projects using ESM module syntax.

### Fixed

- **`renderImports` crash on old-format summaries** — added `Array.isArray` guard; knowledge base entries with the legacy `imports: string[]` format are skipped during rendering instead of throwing.
- **Import extraction from string literals** — static import regexes (`TS_IMPORT_FULL_RE`, `TS_IMPORT_BARE_RE`) now anchored to line start (`^` with `m` flag); prevents false-positive imports being extracted from string literals in test files that contain import syntax as test data.

## [1.4.2] - 2026-06-07

### Added

- **Unit tests** — Vitest suites covering scoring and filtering (`query-engine.test.ts`), config parsing (`config.test.ts`), file lock (`lock.test.ts`); all logic extracted from `index.ts` is now independently testable

### Changed

- **Code structure** — extracted all logic not directly tied to the MCP server out of `index.ts` into dedicated modules: `sampler.ts`, `config.ts`, `lock.ts`, and `analysis-batch.ts`
- **Sampling output schema** — defined via Zod schema instead of manual JSON parsing; reduces fragility on malformed sampling responses
- **`AnalysisSubmission` type** — introduced dedicated interface omitting `exports`/`imports` fields; `summary` is now mandatory

## [1.4.1] - 2026-06-04

### Fixed

- **Subagent batch instruction** — replaced vague "Load the 'submit_analysis' tool" prompt with an explicit ToolSearch query (`query: 'submit_analysis'`) and a prohibition against invoking other skills or tools; reduces Haiku subagent error rate on batch analysis calls

## [1.4.0] - 2026-06-04

### Added

- **`verbosity` parameter on `query`** — optional field controlling data density in results: `full` (default, current behaviour), `structure` (filepath/size/lines/role/analysisDelta/imports/exports/refs — no summary or technologies), `semantic` (filepath/role/technologies/summary/analysisDelta — no imports/exports/refs/lineCount/sizeChars)
- **`PROJECT_INTEL_TOOL_MCP_PROGRESS` / `--mcp-progress`** — enable MCP progress notifications during scan; sends one `notifications/progress` per completed batch; requires harness support for `notifications/progress` (default: `false`)

### Changed

- **`scan` is now blocking** — previously returned immediately while analysis ran in the background; now blocks until all batches are complete and returns `"Scan complete. Analysed N file(s) in M batch(es)."`. Gives the model an accurate signal that knowledge is ready to query and removes the need to race query calls against an incomplete scan.
- **Improved process shutdown** — added `isShuttingDown` guard to prevent double cleanup on concurrent signals; added `stdin:end` and `stdin:close` handlers alongside `SIGTERM`/`SIGINT` for reliable termination on Windows and on MCP client crash; resource release and server close split into separate try/catch blocks with individual error logging

## [1.3.2] - 2026-06-03

### Fixed

- **`query` fluent output missing `refs` field** — `FluentFile` type now includes `refs`; intra-project file references render as `referenced: ...` on a dedicated line below the summary
- **`query` fluent output missing `analysisDelta`** — files with unanalysed changes now show `unanalysed: +N lines +N chars` below the summary, signalling that the semantic summary may be stale

### Changed

- **`query` fluent output connectivity fields** — `imports:` and `exports:` now each render on their own line instead of being joined with ` | `; consistent with `referenced:` line format

## [1.3.1] - 2026-06-03

### Fixed

- **`query` grouped format fallback** — falls back to flat when only one result is returned, or when every folder group contains exactly one file (grouping only activates when at least one group has more than one entry)

### Changed

- **`query` tool description and title** — updated to accurately reflect that keywords match against file path, exports, imports, refs, searchTags, technologies, role, and semantic summary; clarified that structural data is always current without scanning; title changed to "Query project files by path, structure, or semantics"

## [1.3.0] - 2026-06-02

_Query output cleanup, role filter, and analysis schema overhaul._

### Added

- **`role` filter on `query`** — new optional `z.enum` parameter to filter results to a specific file role: `implementation`, `executable`, `helperScript`, `test`, `configuration`, `build`, `documentation`, `data`
- **`searchTags` field** — analysis model generates additional search keywords not already present in summary, role, or technologies; used for scoring (`+3 × semanticWeight`) but excluded from query output

### Changed

- **Role values updated**: `script` renamed to `helperScript`; `executable` and `data` added; full set: `implementation | executable | helperScript | test | configuration | build | documentation | data`. Existing knowledge bases should be rescanned to reclassify files.
- **`purpose` field removed**: replaced by an extended `summary` (~450 chars) covering content, purpose, and key information in a single field. Existing knowledge bases should be rescanned.
- **`format` parameter typed**: `query` `format` is now `z.enum(['grouped', 'flat'])`; invalid values rejected at schema level
- **Query output cleaned up**: `fileScore`, `folderScore`, `query`, and `keywords` removed from all query responses; `scope` only included when set by the caller

### Fixed

- **Stale batch files**: `writeBatchFiles` now clears existing files from `.knowledge/batches/` before writing, preventing orchestration agents from picking up batch files from a previous scan
- **Knowledge directory indexed by git scanner**: `.knowledge/` is now excluded from git-based file scanning, preventing batch prompt files and summaries from being treated as project source files

## [1.2.0] - 2026-06-02

### Added

- `PROJECT_INTEL_TOOL_MCP_ANNOTATIONS_USER_AUDIENCE` / `--user-audience` — append a compact human-readable summary to tool results (e.g. `"Found 9 knowledge entries"`); requires harness support for `annotations.audience`; when unsupported the summary is visible to the model as redundant context (default: `false`)
- `PROJECT_INTEL_TOOL_MCP_STRUCTURED_CONTENT` / `--mcp-structured-content` — include raw result objects as `structuredContent` in tool responses alongside `content[]`; leave disabled unless the harness handles both fields correctly (default: `false`)
- `PROJECT_INTEL_TOOL_SCAN_META` / `--scan-meta`, `PROJECT_INTEL_TOOL_QUERY_META` / `--query-meta`, `PROJECT_INTEL_TOOL_SUBMIT_ANALYSIS_META` / `--submit-analysis-meta` — JSON objects merged into the `_meta` field of each respective tool registration; use for harness-specific flags such as `{"anthropic/maxResultSizeChars":500000,"anthropic/alwaysLoad":true}` (default: `{}`)

### Changed

- Remove hardcoded `anthropic/maxResultSizeChars: 500000` and `anthropic/alwaysLoad: true` from `query` tool `_meta` — now configured via `PROJECT_INTEL_TOOL_QUERY_META`

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

[unreleased]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.5.0...HEAD
[1.5.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.9...ProjectIntelTools_v1.5.0
[1.4.9]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.8...ProjectIntelTools_v1.4.9
[1.4.8]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.7...ProjectIntelTools_v1.4.8
[1.4.7]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.6...ProjectIntelTools_v1.4.7
[1.4.6]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.5...ProjectIntelTools_v1.4.6
[1.4.5]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.4...ProjectIntelTools_v1.4.5
[1.4.4]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.3...ProjectIntelTools_v1.4.4
[1.4.3]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.2...ProjectIntelTools_v1.4.3
[1.4.2]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.1...ProjectIntelTools_v1.4.2
[1.4.1]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.4.0...ProjectIntelTools_v1.4.1
[1.4.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.3.2...ProjectIntelTools_v1.4.0
[1.3.2]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.3.1...ProjectIntelTools_v1.3.2
[1.3.1]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.3.0...ProjectIntelTools_v1.3.1
[1.3.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.2.0...ProjectIntelTools_v1.3.0
[1.2.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.1.0...ProjectIntelTools_v1.2.0
[1.1.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v1.0.0...ProjectIntelTools_v1.1.0
[1.0.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.6.0...ProjectIntelTools_v1.0.0
[0.6.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.5.0...ProjectIntelTools_v0.6.0
[0.5.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.4.0...ProjectIntelTools_v0.5.0
[0.4.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.3.0...ProjectIntelTools_v0.4.0
[0.3.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.2.0...ProjectIntelTools_v0.3.0
[0.2.0]: https://github.com/thoeltig/better-base-tools/compare/ProjectIntelTools_v0.1.0...ProjectIntelTools_v0.2.0
[0.1.0]: https://github.com/thoeltig/better-base-tools/releases/tag/ProjectIntelTools_v0.1.0
