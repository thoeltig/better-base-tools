# Changelog

All notable changes to batch_file_tools are documented here.
Format: [Common Changelog](https://common-changelog.org)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)


## [1.1.2] - 2026-05-20

### Fixed

- Fix duplicate elicitation for session-approved paths — `elicitPaths` now checks the session allow list before prompting; paths already approved in the current session are accepted immediately without re-eliciting

### Changed

- Add `_meta` with `anthropic/maxResultSizeChars: 500000` and `anthropic/alwaysLoad: true` to both `batch_read` and `batch_edit` tool registrations — raises the result size cap because harness side configuration alone resulted in errors and ensures both tools are always loaded by the harness

## [1.1.1] - 2026-05-19

### Changed

- Rewrote `batch_read` tool description: added explicit mode→op pairing table (`verbatim_numbered→replace_range/insert_at_line`, `verbatim→replace/replace_all`, `compact→replace/replace_all` via fuzzy match), restructured use cases as an exploration cascade (fileinfo→compact→verbatim_numbered+searchTerm→edit), clarified `compact+count` as an N-line slice, removed contradictory closing note
- Rewrote `batch_edit` tool description: added upfront op-selection rule linking read mode to edit op choice before the use cases
- Updated `ReadRequest.mode` field description in schema to carry the same mode→op coupling
- Reduced `CLAUDE.md` to two essential points: tool preference override and bundle/plan-ahead principle; removed mode/op detail now covered in tool descriptions

## [1.1.0] - 2026-05-19

### Added

- Accept relative paths in `path` fields for both `batch_read` and `batch_edit` — relative paths (including `./`, `../`, `~/`) resolve against the working directory at each validation site before the allow-list check; globs and directories follow the same rule
- Shorten output paths in all comment headers — paths within the working directory are rendered as relative; paths outside are kept absolute
- Resolve `refs[]` in `fileinfo` mode to working-directory-relative paths — raw import strings (e.g. `../types.js`) are resolved against the containing file's directory and shortened to cwd-relative (e.g. `src/types.js`); paths outside the working directory are kept absolute

### Changed

- Updated `path` field descriptions in both tool schemas to document relative path support

## [1.0.1] - 2026-05-19

### Changed

- Simpler read tool description with more use case examples.

## [1.0.0] - 2026-05-15

### Added

- Add `onProgress` callback to `handleBatchRead` — fires after each file completes via atomic counter; parallel read order preserved
- Add `onProgress` and `onOpDone` callbacks to `handleBatchEdit` — progress counter increments per op via `try/finally`; handles early-exit on buffer-load errors
- Add `mcpLog` helper — fire-and-forget logging at entry, success, and error per tool call via `server.sendLoggingMessage`
- Add `reportProgress` helper — reads `progressToken` from `_meta`, sends `notifications/progress`; no-op when client sends no token
- Add `logging: {}` server capability declaration
- Add elicitation decision logging — accept (info, notes session scope), deny (info), and elicitation errors (warning)

## [0.9.0] - 2026-05-15

### Changed

- Replace single-batch elicitation form with per-file sequential prompts — one `elicitInput` per unauthorized path; message shows tool name, path, and detail (`mode: X` for reads, `ops: a, b` for edits)
- Split session allow list by tool type — `sessionAllowedReadPaths` and `sessionAllowedEditPaths` are independent; folder approved for `batch_read` does not auto-allow `batch_edit`

### Fixed

- Fix allow-once path scope — `relative(p, p) === ""` correctly scopes allow-once to exact file without leaking sibling files

## [0.8.0] - 2026-05-14

### Changed

- Merge `fileinfo_refs` into `fileinfo` — `refs[]` always computed, omitted when empty; `ReadMode` reduced by one entry
- Redesign `batch_edit` output — all-success collapses to single `<!-- batch_edit OK — N files -->` comment; errors emit one summary block plus separate per-op anchor blocks
- Remove `verbose` flag — output is always compact; stripped from schema, descriptions, and test fixtures

### Added

- Add elicitation for unauthorized paths — `elicitPaths()` prompts per-path checkbox form before returning `not_authorized`; approved parent directories added to session allow list for the call
- Add allow-once and allow-folder options per elicitation prompt — allow-once scopes to exact file; allow-folder adds parent directory and persists for the session via module-level `sessionAllowedPaths`
- Add `batch_edit` use-case guidance for multi-line content — description notes to prefer `replace_range` / `insert_at_line` over `replace` to avoid JSON string escaping of newlines

## [0.7.0] - 2026-05-09

### Added

- Add `fileinfo_refs` read mode — metadata plus `refs[]` extracted via regex (imports, requires, includes)

### Changed

- Reframe `compact` mode description — clarify it is the correct default for reading-to-understand, not a degraded mode
- Update `fileinfo` description — note ISO 8601 mtime format; clarify field names

## [0.6.0] - 2026-05-08

### Removed

- Remove `batch_edit_text` tool — model mixes JSON and text-format input syntax on longer sessions; will be revisited

### Added

- Add `fileinfo` read mode — per-file metadata: size (bytes), line count, mtime (ISO 8601), `isFile` flag
- Add `searchTerm` parameter to `batch_read` — case-insensitive match returning ±`count` context lines around each hit; each match block prefixed with `<!-- Match at line N -->`
- Add glob and directory expansion to `batch_read` — glob patterns expand to matched files; bare directory paths expand to immediate children
- Add `disableNormalizedFormatting` flag — bypass 2-space indent normalization and receive original file indentation

### Changed

- Normalize indentation in `verbatim` and `verbatim_numbered` modes to 2 spaces per indent level by default

## [0.5.0] - 2026-04-27

### Added

- Add `batch_edit_text` tool — line-based text-format variant; better token efficiency for content-heavy single ops (≥~15 lines per op)
- Add op-level `stopOnError` — resolution: `op ?? file ?? root ?? false`; lowest defined level wins

### Changed

- Rename `continueOnError` to `stopOnError` and flip default — default is now `false` (continue on error)
- Replace `output` enum with `verbose` boolean at root/file/op level; op-wins precedence
- Drop diff output — `diffContent` field and `jsdiff` dependency removed
- Add workload-shape guidance to tool descriptions — ≤~5 lines per op prefers `batch_edit`; ≥~15 lines prefers `batch_edit_text`

## [0.4.0] - 2026-04-25

### Added

- Add glob and directory path expansion for `batch_edit` — `replace`, `replace_all`, and `write(append)` apply to all matched files; other ops return `not_supported` on glob paths
- Add glob entry merging — concrete and glob-expanded entries for the same resolved file merge their ops in input order

### Changed

- Finalize read mode enum — rename `edit | info_compact | info_verbatim` to `verbatim_numbered | compact | verbatim`; remove `info_` stepping-stone prefix
- Unify `Reason` enum — collapse `FileErrorReason` and `EditErrorReason` into a single `Reason`; drop `file_missing` (folded into `not_found`; `nextAction` text disambiguates)
- Compose allowed directories — `getAllowedDirectoriesToUse()` returns union of harness-provided roots and `--args` paths instead of ternary override

## [0.3.0] - 2026-04-24

### Added

- Add `resolveForWrite` — walks up to the nearest existing ancestor, joins missing path segments, and validates the synthesized real path against the allow list before any write

### Changed

- Collapse `create`, `overwrite`, `append`, and `delete` ops into `write(mode: 'overwrite' | 'append')` — `delete` removed; callers use `replace(new: '')`
- Upgrade `compact` mode transforms — add multi-whitespace-run collapse, leading-indent stripping for non-indent-sensitive file types, and JSON minification; mode is now explicitly lossy
- Simplify execution to 2 phases — remove dedicated `create` phase; phase 1 = line-addressed ops sorted DESC, phase 2 = everything else in input order
- Simplify path utilities — replace reference-server normalization with Node `path.resolve` + `fs.realpath`

### Fixed

- Fix auth bypass — `create`/`overwrite` ops on non-existent targets skipped the allow-list check; `resolveForWrite` closes the hole
- Fix error reason propagation — `buildFileLoadErrorResult` now surfaces the actual reason (`not_authorized`, `not_found`, etc.) instead of hardcoded `io_error`

## [0.2.0] - 2026-04-22

### Added

- Add `nearest_anchor` hint on `not_found` errors — verbatim bounded snippet around the closest match (Levenshtein threshold 0.30), uniqueness-checked with one widening retry, pasteable as the corrected `old` string; includes `nearest_line` and `next_action` fields
- Add two-phase execution per file — line-addressed ops (`insert_at_line`, `replace_range`) sorted DESC by anchor line run first so anchors always reference the original buffer; overlapping phase-1 ranges error both conflicting ops
- Add `skipped` op status — emitted for ops after an aborted op when `stopOnError` is true for that file

### Changed

- Rename read modes — `edit | raw | compact` → `edit | info_compact | info_verbatim`; flips default bias toward info reading; prepares for v2 mode/strategy split
- Replace `returnDiff` flag with `output: minimal | summary | diff` at root/file/op level — op-wins precedence; `minimal` filters successful ops from results
- Switch to per-file `TextContent` envelope — one content block per file with HTML-comment meta (file and per-op status) and raw unescaped body (diffs, `nearest_anchor` sub-blocks)
- Remove `structuredContent` from both tool responses — harness was re-JSON-wrapping the envelope, re-introducing `\n → \\n` escaping
- Replace custom diff format with `structuredPatch` hunks — standard `@@ -N,M +N,M @@` headers, ` `/`-`/`+` per-line prefixes, 3-line context

## [0.1.0] - 2026-04-22

_First release._

### Added

- Add `batch_read` tool — read N files per call; modes: `edit` (line-numbered, byte-exact), `raw` (byte-exact, no line numbers), `compact` (whitespace-normalized); `offset` + `limit` pagination per file
- Add `batch_edit` tool — multi-file, multi-op edits per call; ops: `replace`, `replace_all`, `insert_at_line`, `replace_range`, `append`, `create`, `overwrite`, `delete`
- Add error contract — reasons: `not_found`, `ambiguous`, `file_missing`, `file_exists`, `invalid_range`, `io_error`; `nearest_line` (Levenshtein similarity > 0.30) and `match_lines` hints
- Add per-op `summary` string on all op results
- Add `continueOnError` at root and file level — file level wins over root
- Add `dryRun` — full execution without writes; diffs computed and returned as if applied
- Add `output: minimal | summary | diff` verbosity at root/file/op level
- Register via project-scope `.mcp.json`

[1.0.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v1.0.0
[0.9.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.9.0
[0.8.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.8.0
[0.7.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.7.0
[0.6.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.6.0
[0.5.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.5.0
[0.4.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.4.0
[0.3.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.3.0
[0.2.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.2.0
[0.1.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.1.0
