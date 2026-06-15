# Changelog

All notable changes to batch_file_tools are documented here.
Format: [Common Changelog](https://common-changelog.org)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)


## [Unreleased]

## [1.2.5] - 2026-06-15

### Added

- `tests/helpers/reporter.js` — custom streaming reporter with compact, LLM-optimised output: summary header (`✓ N passed  ✖ N failed`), failing test name with `file:line-col`, inline source line in backticks, and `returned:` value
- `tests/helpers/expect.ts` — `expect()` wrapper around `node:assert/strict` with a Vitest-compatible API to reduce necessary changes to existing tests

### Changed

- Replaced Vitest with Node.js built-in `node:test` runner — remove `vitest` dev dependency and `vitest.config.ts`, add `tsx` and `esbuild` for TypeScript execution; all 11 test files updated
- Updated `zod` to `4.4.3`

## [1.2.4] - 2026-06-07

### Changed

- **`searchTerm` regex support in `batch_read`** — `searchTerm` now accepts a regex pattern (case-insensitive `RegExp` with `i` flag). Simple keyword strings continue to work identically since valid literals are also valid regex. Invalid patterns fall back to literal case-insensitive `includes` matching.
- **Session start instructions inlined into hook script** — removed the `CLAUDE.md` file that the session start hook loaded to inject usage instructions; content is now embedded directly in the hook script, eliminating a file read on every session start.

## [1.2.3] - 2026-06-04

### Added

- **Process shutdown handling** — `isShuttingDown` guard prevents double cleanup on concurrent signals; `stdin:end` and `stdin:close` handlers alongside `SIGTERM`/`SIGINT` ensure reliable termination on Windows and on MCP client crash; server close wrapped in try/catch with error logging

## [1.2.2] - 2026-06-03

### Added

- **`fileinfo` mode opt-in flag** — `fileinfo` is now disabled by default; enable via `BATCH_TOOLS_READ_ENABLE_FILEINFO=true` / `--read-enable-fileinfo=true`. When disabled the mode is absent from the schema enum and tool description entirely, so the model never sees it.

### Changed

- **`fileinfo` output format** — replaced JSON blob with fluent-text format matching project-intel-tool style: `<!-- path (Lines: N, Size: N) lastChanged: Xd Yh -->` header line followed by an optional `referenced: path1, path2` line when intra-project refs are present
- **`fileinfo` `lastChanged` field** — replaces ISO `mtime` string with a human-readable relative duration (e.g. `3d 4h`, `2mo 5d`, `1y 2mo`); at most two units shown, zero-value units omitted, minimum `< 1min`
- **`fileinfo` removed `isFile` field** — was always `true` since the mode only processes files

## [1.2.1] - 2026-06-01

### Fixed

- Fix `batch_edit` always reporting `0 ops successful` — `filterOps` in `edit.ts` stripped successful ops from `FileResult.ops` before returning; `envelope.ts` read counts from the already-filtered array, so `okOps` was always 0 regardless of actual results. Fix: add required `totalOps: number` to `FileResult` (captured before filtering in all construction sites), update `envelope.ts` to derive `okOps = totalOps - nonOkOps` directly.
- Fix per-file header in error output always showing `0/N` — same root cause as above; `fileOkOps/fileTotalOps` also read from the filtered `r.ops` array instead of `r.totalOps`.

### Changed

- Merge `batch_edit` error output into a single content block — overview and per-file error sections are now joined with `\n\n` in one block instead of separate `content[]` entries, removing the nested sub-item rendering in Claude Code.

## [1.2.0] - 2026-06-01

### Changed
- Replace `verbatim_numbered` with line-range headers on sliced reads — `verbatim` with `offset`+`count` now emits `<!-- Read line X to Y of file '...' as 'mode' (N of M lines total) -->` in the output header; the line range anchors `replace_range`/`insert_at_line` without a separate mode
- Search output redesigned — `count=0` (default): each match returned as inline `lineNum\tcontent`; `count>0` (context lines): match windows use `<!-- Line M to N, match at line K -->` per block; the outer `<!-- Found N match(es) in M lines ... -->` header is preserved for both variants
- Search context blocks merged — overlapping or near-adjacent context windows (gap ≤ `SEARCH_MERGE_GAP = 3` lines) are collapsed into a single block; single-match blocks retain `<!-- Line M to N, match at line K -->`; multi-match merged blocks use `<!-- Line M to N -->` only
- Single-line read header simplified — when a read returns exactly one line, header uses `<!-- Read line N of file '...' -->` instead of `<!-- Read line N to N ... -->`
- `batch_edit` output redesigned — replaces multi-line HTML comment error block with flat single-line comments: overview `<!-- Edit: N files, X ops successful -->` (or `X/Y` when errors present); per-file section `<!-- 'path': X/Y ops successful -->` followed by `<!-- file error: reason: msg -->` or `<!-- file; skipped -->` for file-level failures; per-op error `<!-- op N (type); error: ...[; possible verbatim anchor: lines A-B] -->` with anchor content inline below; skipped op ranges as `<!-- ops N to M; skipped -->`; successful files not listed
- Zero-match search results consolidated — all files with no matches in a single call are merged into one output block (`<!-- No match(es) found -->\n'file1'\n...`) instead of one block per file
- Add `start_line` to `ReadResult` — set on all regular reads (`req.offset ?? 1`); enables the envelope to compute the correct line range for the header

### Removed
- `verbatim_numbered` from `ReadMode` enum — use `verbatim`+`offset`+`count` for targeted slices; the output header now carries the line range
- `formatEdit()` from `transforms.ts` — was only used by `verbatim_numbered`

## [1.1.7] - 2026-06-01

### Changed
- Move indent-normalization control from per-request `disableNormalizedFormatting` to server-level config — `BATCH_TOOLS_NORMALIZE_FORMATTING` / `--normalize-formatting` (default: `true`); normalization applies to all reads unless disabled globally; `deduplicatePath` simplified by removing the `normGroups` grouping map that existed only to key on that field

### Removed
- `disableNormalizedFormatting` from `ReadRequest` schema — per-call opt-out replaced by `BATCH_TOOLS_NORMALIZE_FORMATTING` server config

## [1.1.6] - 2026-05-31

### Added

- `BATCH_TOOLS_MCP_LOGGING` / `--mcp-logging` env/arg — toggle MCP protocol logging; falls back to `console.error` for errors when disabled (default: `false`)
- `BATCH_TOOLS_MCP_ANNOTATIONS_USER_AUDIENCE` / `--user-audience` env/arg — append a compact human-readable summary to tool results (e.g. `"Read 5 — compact: 3, fileinfo: 2"`); requires harness support for `annotations.audience` (default: `false`)
- `BATCH_TOOLS_READ_META` / `--read-meta` and `BATCH_TOOLS_EDIT_META` / `--edit-meta` env/args — JSON objects merged into the `_meta` field of each tool registration; use for harness-specific flags such as `{"anthropic/maxResultSizeChars":500000,"anthropic/alwaysLoad":true}` (default: `{}`)
- `BATCH_TOOLS_DRY_RUN` / `--dry-run` env/arg — run `batch_edit` without writing any files; all ops are validated and results reported as if applied (default: `false`)
- `BATCH_TOOLS_MCP_STRUCTURED_CONTENT` / `--mcp-structured-content` env/arg — include raw result objects as `structuredContent` in tool responses alongside `content[]`; for harnesses that support both correctly (default: `false`)

### Changed

- Remove hardcoded `anthropic/maxResultSizeChars` and `anthropic/alwaysLoad` from `_meta` — now configured via `BATCH_TOOLS_READ_META` / `BATCH_TOOLS_EDIT_META`

### Removed

- `batch_edit_text` tool — concept did not work correctly with existing harnesses
- `dryRun` field from `batch_edit` input schema — replaced by `BATCH_TOOLS_DRY_RUN` server-level env/arg

## [1.1.5] - 2026-05-27

### Added

- Path normalisation via `safeRealpath(resolve(...))` applied at entry in `batch_read` and in `batch_edit` (direct and glob-expanded paths) — uses `realpath()` to produce OS-canonical paths, falling back to `resolve()` for non-existent files; fixes symlink and case-insensitive deduplication
- `batch_read` per-call file content cache — all unique paths (including `fileinfo`) are read once before result processing; `fileinfo` still calls `stat` for metadata but pulls content from cache; eliminates redundant I/O calls

## [1.1.4] - 2026-05-26

### Added

- Deduplicate `batch_read` requests within a single call — after glob expansion, requests for the same file are collapsed: `fileinfo` to one entry; search requests by `(searchTerm, count, disableNorm)` with mode coalescion (same→same, mixed→`verbatim`); range/full-file requests by `(disableNorm)` with mode coalescion and overlapping/adjacent range merging. Single-source entries pass through unchanged; multi-source merges produce the coalesced result. `verbatim_numbered` merged to a full-file range downgrades to `verbatim`.
- Normalize all request paths via `resolve()` in `expandReadRequests` — previously only relative paths were resolved, causing glob-expanded and explicitly specified paths to the same file to not deduplicate on Windows due to separator differences

## [1.1.3] - 2026-05-20

### Changed

- Enforce `verbatim_numbered` restriction via schema validation — requires `searchTerm`, `offset`, or `count`; full-file reads without these return a validation error directing the model to use `compact` or `verbatim` instead
- Rewrite mode descriptions in `batch_read` tool and `ReadRequest.mode` field — remove "verbatim anchors are more reliable" bias; position `compact` as the correct default for full-file reads, `verbatim` for exact-whitespace full-file reads, `verbatim_numbered` as targeted-slice only
- Update Mode→op pairing in both tools: `compact`/`verbatim` → `replace`/`replace_all`; `verbatim_numbered+searchTerm/offset` → `replace_range`/`insert_at_line`
- Update `batch_read` use-case cascade: `compact` at position 2 (full-file, lowest cost), `verbatim` at 3 (full-file, exact whitespace), `verbatim_numbered` at 4 (targeted slice only)
- Update `batch_edit` use cases to distinguish full-file edits (compact/verbatim → replace) from targeted edits (verbatim_numbered → replace_range/insert_at_line)
- Clarify `disableNormalizedFormatting`: only set true when indentation itself is being edited (indent-style fixes, tab-to-space); leave false for all other reads

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

[unreleased]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.2.5...HEAD
[1.2.5]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.2.4...BatchFileTools_v1.2.5
[1.2.4]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.2.3...BatchFileTools_v1.2.4
[1.2.3]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.2.2...BatchFileTools_v1.2.3
[1.2.2]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.2.1...BatchFileTools_v1.2.2
[1.2.1]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.2.0...BatchFileTools_v1.2.1
[1.2.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.7...BatchFileTools_v1.2.0
[1.1.7]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.6...BatchFileTools_v1.1.7
[1.1.6]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.5...BatchFileTools_v1.1.6
[1.1.5]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.4...BatchFileTools_v1.1.5
[1.1.4]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.3...BatchFileTools_v1.1.4
[1.1.3]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.2...BatchFileTools_v1.1.3
[1.1.2]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.1...BatchFileTools_v1.1.2
[1.1.1]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.1.0...BatchFileTools_v1.1.1
[1.1.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.0.1...BatchFileTools_v1.1.0
[1.0.1]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v1.0.0...BatchFileTools_v1.0.1
[1.0.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.9.0...BatchFileTools_v1.0.0
[0.9.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.8.0...BatchFileTools_v0.9.0
[0.8.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.7.0...BatchFileTools_v0.8.0
[0.7.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.6.0...BatchFileTools_v0.7.0
[0.6.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.5.0...BatchFileTools_v0.6.0
[0.5.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.4.0...BatchFileTools_v0.5.0
[0.4.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.3.0...BatchFileTools_v0.4.0
[0.3.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.2.0...BatchFileTools_v0.3.0
[0.2.0]: https://github.com/thoeltig/better-base-tools/compare/BatchFileTools_v0.1.0...BatchFileTools_v0.2.0
[0.1.0]: https://github.com/thoeltig/better-base-tools/releases/tag/BatchFileTools_v0.1.0
