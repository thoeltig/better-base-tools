# Base Tools — Implementation Plan

Companion to `tool-redesign-notes.md`. That file holds the reasoning; this file holds the spec, build status, and roadmap.

---

## Status — v1 MVP shipped

Built as an MCP server at `plugins/batch_file_tools/`, exposing two tools: `batch_read` and `batch_edit`. Registered via project-scope `.mcp.json`. 93 tests pass, 0 npm vulnerabilities, strict TypeScript.

**Delivered (v1):**

| Capability | Status |
|---|---|
| Batch `batch_read` — N files per call, per-file mode | ✅ |
| Read mode `edit` — line-numbered (`{n}\t{content}\n`, unpadded), byte-exact | ✅ |
| Read mode `raw` — content only, byte-exact (CRLF preserved) | ✅ |
| Read mode `compact` — strip trailing whitespace + collapse blank-line runs | ✅ |
| `offset` / `limit` per file (1-indexed source lines) | ✅ |
| `batch_edit` line-addressed ops: `create`, `overwrite`, `append`, `insert_at_line`, `replace_range` | ✅ |
| `batch_edit` content-addressed ops: `replace`, `replace_all`, `delete` | ✅ |
| Per-op `summary` string (always emitted) | ✅ |
| Error contract: `not_found` / `ambiguous` / `file_missing` / `file_exists` / `invalid_range` / `io_error` | ✅ |
| `nearest_line` hint via Levenshtein (threshold 0.30) | ✅ |
| `match_lines` hint for ambiguous anchors | ✅ |
| `continueOnError` — top-level (inter-file) + file-level (intra-file, wins over top) | ✅ |
| `dryRun` — full execution, no writes, diffs still returned | ✅ |
| `returnDiff` — `none` / `per_file` / `per_op` (unified diff via `diff` package) | ✅ |
| Project-scope MCP registration via `.mcp.json` | ✅ |
| Dev-environment `CLAUDE.md` directive (interim, pre-SessionStart-hook) | ✅ |

**Deviations from spec as originally written:**

- Tool names: `batch_read` / `batch_edit` (not `Read` / `Edit`) to avoid collision with built-ins.
- Read modes collapsed from `info | raw | compact | optimized` to `edit | raw | compact` — `info` and `optimized` deferred to v2.
- `raw` mode no longer carries line numbers; line-numbered reading is now `edit` mode. This matches the actual two use cases (read-to-edit vs read-to-understand) cleaner than the original mode names did.
- Line-number format in `edit` mode: unpadded `{n}\t{content}\n` rather than `cat -n`'s fixed-width padding (saves tokens at minor cost to visual alignment).
- Added `skipped` op status for ops after an aborted op, alongside `ok`/`error`.
- `delete` kept as explicit op (per spec) but internally delegates to `replace` with `new=""`.

---

## Goal (unchanged)

Redesign Read/Edit primitives for token efficiency and fewer round-trips: batch I/O, explicit mode tradeoffs per file, multi-op edits with per-op error handling, and actionable error hints.

---

## `batch_read` — current contract (v1)

Batch read of N files, mode required per file.

### Input

```json
{
  "requests": [
    {
      "path": "absolute path",
      "mode": "edit | raw | compact",
      "offset": "int, optional, 1-indexed source line",
      "limit": "int, optional, line count"
    }
  ]
}
```

### Modes

| Mode | Contract | Line numbers | Use case |
|---|---|---|---|
| `edit` | Byte-exact content, each line prefixed `{sourceLineNum}\t` | Yes | Pre-edit anchor reads (required for `replace` / `replace_all` / `delete`) |
| `raw` | Byte-exact content, no transformation | No | Verbatim content piping |
| `compact` | Lossless: strip trailing whitespace on each line, collapse runs of 2+ blank lines to 1 blank line. Leading indent preserved. | No | Scanning / reading to understand |

`offset` + `limit` slice the source file first; `compact` mode compacts the slice (keeps offsets meaningful in source-line terms).

### Output per file

```json
{
  "path": "...",
  "mode_applied": "edit | raw | compact",
  "lines": "int, source file line count",
  "returned_lines": "int, lines in response (post-compact count for compact mode)",
  "truncated": "bool",
  "content": "string, omitted on error",
  "error": {
    "reason": "not_found | not_absolute | is_directory | io_error",
    "message": "string"
  }
}
```

---

## `batch_edit` — current contract (v1)

Multi-file, multi-op edit.

### Input

```json
{
  "continueOnError": "bool, default false",
  "dryRun": "bool, default false",
  "returnDiff": "none | per_file | per_op, default none",
  "files": [
    {
      "path": "absolute path",
      "continueOnError": "bool, optional, overrides top-level for this file's ops",
      "ops": [
        { "type": "replace",        "old": "...", "new": "..." },
        { "type": "replace_all",    "old": "...", "new": "..." },
        { "type": "insert_at_line", "line": "int", "content": "..." },
        { "type": "replace_range",  "start": "int", "end": "int", "content": "..." },
        { "type": "append",         "content": "..." },
        { "type": "delete",         "old": "..." },
        { "type": "create",         "content": "..." },
        { "type": "overwrite",      "content": "..." }
      ]
    }
  ]
}
```

### Op semantics

| Op | Requires prior read | Notes |
|---|---|---|
| `replace` | Yes | Errors if `old` not found or non-unique |
| `replace_all` | Yes | 1+ matches required; no uniqueness check |
| `insert_at_line` | No | Inserts before the given line; `line = lines.length + 1` equivalent to append |
| `replace_range` | No | Replaces lines `start..end` inclusive |
| `append` | No | Appends to EOF **literally** (no implicit newline). Creates file + parents if missing. |
| `delete` | Yes | Aliases `replace` with `new=""`; kept explicit for log readability |
| `create` | No | Fails if file exists. Auto-creates parent directories. Empty content → empty file. |
| `overwrite` | No | Replaces full content regardless of prior state. Auto-creates file + parents. Empty content truncates. |

Ops within a file execute sequentially; each sees post-previous-op state. Line-based ops after content-based ops should expect line drift.

### Output

```json
{
  "results": [
    {
      "path": "...",
      "diff": "unified diff (whole file), present only if returnDiff == 'per_file'",
      "ops": [
        { "index": 0, "status": "ok",
          "summary": "replaced 1 occurrence at line 42 (3 chars → 5 chars)",
          "diff": "unified diff, present only if returnDiff == 'per_op'" },
        { "index": 1, "status": "error", "reason": "not_found",
          "hint": { "nearest_line": 42, "next_action": "..." } },
        { "index": 2, "status": "skipped" }
      ]
    }
  ]
}
```

`status: "skipped"` indicates an op was not attempted because a prior op errored and `continueOnError` is false for this file.

### Summary conventions (per op)

| Op | Example |
|---|---|
| `replace` | `"replaced 1 occurrence at line 42 (3 chars → 5 chars)"` |
| `replace_all` | `"replaced 7 occurrences (lines 12, 18, 34, 51, 67)"` or `"replaced 23 occurrences (first: line 4, last: line 198)"` when >5 |
| `insert_at_line` | `"inserted 3 lines at line 42"` |
| `replace_range` | `"replaced lines 10-20 (11 lines → 8 lines)"` |
| `append` | `"appended 5 lines (EOF was line 120)"` |
| `delete` | `"deleted 2 lines at line 42"` |
| `create` | `"created file (23 lines, 512 bytes)"` |
| `overwrite` | `"overwrote file (was 100 lines, now 87 lines)"` |

### Error contract

```json
{
  "status": "error",
  "reason": "not_found | ambiguous | file_missing | file_exists | invalid_range | io_error",
  "hint": {
    "nearest_line": "int, optional",
    "match_lines": "[int, ...], optional",
    "next_action": "string"
  }
}
```

- `not_found`: `nearest_line` populated if similarity > 0.30; omitted otherwise; `nearest_line` also skipped on files >5000 lines (perf cap).
- `ambiguous`: `match_lines` lists all 1-indexed line numbers where `old` matches.
- `file_missing`: target required by the op does not exist.
- `file_exists`: `create` against existing file.
- `invalid_range`: `replace_range` or `insert_at_line` with out-of-bounds / reversed indices.
- `io_error`: filesystem failure, non-absolute path, is-a-directory, etc.

### Control flow

- Top-level `continueOnError: true` — a file with errored ops doesn't abort sibling files.
- File-level `continueOnError: true` — a failed op doesn't skip sibling ops in that file.
- File-level setting wins when both set.
- `dryRun: true` — no writes; diffs computed and returned as if applied.
- Partial writes: if file-level `continueOnError: true` and some ops fail while others succeed, the successful ops ARE persisted.

---

## v2 roadmap (next)

Priority order based on expected impact × implementation cost.

### High priority — completes the original spec

| Item | Spec-driven notes |
|---|---|
| **Mode/strategy split** | Refactor flat `mode: edit\|raw\|compact` into `mode: edit\|info` + `strategy: peek\|raw\|compact\|optimized`. Enforce `mode=edit → strategy=raw`. Keeps current call sites working via migration mapping. |
| **`info` mode (peek)** | Metadata only — no content. Returns: `type`, `bytes`, `lines`, `symbols`, `imports_exports`, `schema.top_level_keys`, `schema.depth`. Needs per-language parser (tree-sitter or regex heuristics). Cheap size/shape probe before committing to full read. |
| **`optimized` strategy** | Lossy transforms from the original benchmark table: `JSON_PRETTY→JSON_COMPACT` (~60-70% reduction), `XML→JSON_COMPACT` when data-shaped, `YAML→JSON_COMPACT`, code-file comment stripping. Needs `data-shaped` safety heuristic for XML (no mixed content, attrs on leaves only). Informational use ONLY — never for pre-edit reads. |
| **`token_estimate` in info output** | Per-mode token count estimate (`{raw, compact, optimized}`). Rough — Anthropic's tokenizer isn't public. Document the approximation clearly so agents don't misuse. |
| **Richer `compact` transforms** | Currently whitespace-only. Add: code comment stripping (language-aware), markdown HTML-comment stripping, JSON pretty→compact. Kept lossless. |

### Medium priority — packaging & UX for release

| Item | Notes |
|---|---|
| **`SessionStart` hook** | Replaces interim `CLAUDE.md` directive. Injects tool-preference guidance automatically when the plugin is installed, so end users don't edit their `CLAUDE.md`. |
| **Refined tool descriptions** | Shorten + punchify the `description` fields on `batch_read` / `batch_edit`. Current descriptions are functional; release should nudge agent toward correct mode/op selection without reading the whole schema. |
| **Watch + reconnect in dev** | Live rebuild + MCP reconnect without Claude Code session restart. Requires either MCP protocol reconnect support or a wrapper process. |
| **Tool-name review** | `batch_` prefix is descriptive but passive. Consider `efficient_` / `improved_` at release if dogfooding shows the built-ins still get preferred by default. |

### Low priority — on-signal features

| Item | Revisit when |
|---|---|
| `expected_hash` / stale-read detection | Concurrent-write bugs surface in practice |
| Token-based read cap (vs line-based) | Read truncation becomes recurring friction |
| `Read` diff mode (content diff vs last read) | Repeated-read workflows become common |
| TOON as explicit `optimized` opt-in flag | Caller verifies data is dense + flat |
| File watcher | Undo across external edits becomes a need |
| Undo / inverse-op history | "Experiment and revert" flow requested |
| Lossy-transform fidelity metadata | Agent decisions shown to be misled by `optimized` |
| Multi-file atomic rollback | Real partial-failure pain observed on refactors |
| `regex` edit op | Pattern-wide renames become a bottleneck |
| AST / structural edits | Language-aware refactors dominate workload |
| Prompt-cache-aware mode selection | Harness caching model known |
| Symlink / encoding / CRLF handling spec | Failures observed on Windows or non-UTF-8 files |

---

## Open questions

Resolved during implementation:

- ~~`FileInfo` standalone tool or Read mode?~~ → **Read mode** (`mode: "info"`), deferred to v2.
- ~~`create` Edit op or standalone tool?~~ → **Edit op**. Write folded into Edit via `create` + `overwrite`.
- ~~`mode` required per request vs default `raw`?~~ → **Required.**
- ~~`delete` explicit op or alias `replace → ""`?~~ → **Explicit op**, internally delegated to `replace` for DRY. Summary/error readability worth the extra switch case.
- ~~Diff format — unified vs JSON?~~ → **Unified** (via `diff` package).
- ~~Tool naming — `bt_` / `batch_` / `efficient_`?~~ → **`batch_`** for v1. Revisit at release if built-ins still preferred by default.

Still open:

1. **Info mode depth for large files** — full symbol list vs top-level only with drill-down flag? Tune after usage data once `info` ships.
2. **XML→JSON transform safety heuristic** — what makes XML "data-shaped" enough to auto-convert in `optimized` mode? Likely: no mixed content, attributes only on leaf elements. Needs spec before implementation.
3. **Mode/strategy split timing** — refactor before v2 feature work, or stay flat until a third mode lands? Leaning: do the split when `info` lands, not earlier.

---

## Success criteria (unchanged)

- Typical "read 5 files for context, edit 1 file with 3 ops" workflow: ≥50% token reduction vs built-in `Read`/`Edit`/`Write` chain
- Edit failure rate on a reference refactor set: no increase vs built-in `Edit`
- Follow-up Read calls triggered by edit errors: ≥70% reduction via error hints

Measurement happens once the MCP is dogfooded in real sessions for a week+.

---

## Build order

v1 (complete):

1. ✅ MCP server scaffold — stdio transport, both tools registered, strict TypeScript, pinned deps, 0 vulns
2. ✅ `batch_read` — `edit` + `raw` modes, batch input, offset/limit
3. ✅ `batch_edit` line-addressed ops — `create`, `overwrite`, `append`, `insert_at_line`, `replace_range`
4. ✅ `batch_read` `compact` mode (reordered after edit ops; higher-leverage sequence)
5. ✅ `batch_edit` content-addressed ops — `replace`, `replace_all`, `delete`
6. ✅ Error contract + `nearest_line` (Levenshtein) + `match_lines` hints
7. ✅ `continueOnError` (top + file level), `dryRun`, `returnDiff`
8. ✅ End-to-end stdio round-trip verified, project-scope `.mcp.json` registered

v2 (next):

9. Dogfood for 1 week; collect failure modes + token measurements
10. `info` mode + `token_estimate` (per-language parser needed)
11. Mode/strategy split refactor
12. `optimized` strategy (JSON/XML/YAML transforms with safety heuristics)
13. Richer `compact` (comment stripping, JSON minification)
14. `SessionStart` hook + refined tool descriptions for plugin release
