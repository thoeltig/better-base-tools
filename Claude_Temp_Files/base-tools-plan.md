# Base Tools v1 — Implementation Plan

Companion to `tool-redesign-notes.md`. That file holds the reasoning; this file holds the spec and the deferred items.

## Goal

Redesign Read/Edit primitives for token efficiency and fewer round-trips: batch I/O, explicit token-mode tradeoffs per file, multi-op edits with per-op error handling, and actionable error hints.

## Scope (v1)

Two tools: `Read`, `Edit`.

- `FileInfo` is a **mode of `Read`**, not a separate tool (decided — keeps tool count low, output shape handled via optional fields).
- Write is folded into `Edit` via `create` and `overwrite` ops (decided — no value in a third tool once Edit is batch-capable).

---

## `Read`

Batch read of N files, mode selected per file. No implicit default mode — `mode` is required per request.

### Input

```json
{
  "requests": [
    {
      "path": "absolute path",
      "mode": "info | raw | compact | optimized",
      "offset": "int, optional, 1-indexed line (ignored for info)",
      "limit": "int, optional, line count (ignored for info)"
    }
  ]
}
```

### Modes

| Mode | Contract | Line numbers | Use case |
|---|---|---|---|
| `info` | No content. Returns metadata: type, bytes, lines, symbols, imports/exports, schema, token_estimate per mode | N/A | Cheap HEAD-equivalent peek before deciding full read |
| `raw` | Byte-exact, highest fidelity | Yes | Pre-edit anchor reads (required for `replace` / `replace_all` / `delete` ops) |
| `compact` | **Lossless** compaction: strip trailing whitespace, collapse blank-line runs, format-preserving minification (JSON_PRETTY→JSON_COMPACT, XML_PRETTY→XML_COMPACT) | No | Mid-cost info reads; safe by default |
| `optimized` | **Lossy** transforms — informational use ONLY. Explicit rules below. Never for pre-edit reads. | No | Low-cost scanning when fidelity loss is acceptable |

### `optimized` mode transform rules (deterministic, benchmark-informed)

Based on internal file-format token benchmark (Sonnet 4.6):

| Source format | Transform | Expected token reduction | Accuracy cost |
|---|---|---|---|
| JSON_PRETTY | → JSON_COMPACT | ~60-70% | ~0% |
| XML_PRETTY | → JSON_COMPACT (when data-shaped: no mixed content, no attributes-as-semantics) | ~65-75% | 0-0.5% |
| XML_COMPACT | → JSON_COMPACT (same conditions) | ~55-65% | 0-0.5% |
| YAML | → JSON_COMPACT | ~40-50% | 0-0.5% |
| CSV | no change (already optimal for flat tabular) | 0% | 0% |
| Code files (any) | strip comments, collapse blank lines; preserve structure | 10-25% | 0% (if no semantic comments) |
| Markdown | strip HTML comments, collapse blank lines | 5-15% | 0% |

**Explicitly NOT auto-applied**: TOON conversion (only beneficial on dense/flat data; collapses +185% on sparse). Opt-in via explicit flag only if added later.

**Tool output always reports the applied transform** in `mode_applied` so the agent knows fidelity characteristics without guessing.

### Output (per file)

Content modes (`raw | compact | optimized`):

```json
{
  "path": "...",
  "content": "...",
  "mode_applied": "raw | compact | optimized (with transform note, e.g. 'xml→json_compact')",
  "lines": "int, source file line count",
  "returned_lines": "int, lines included in response",
  "truncated": "bool"
}
```

Info mode (`mode: "info"`):

```json
{
  "path": "...",
  "mode_applied": "info",
  "type": "python | typescript | json | markdown | ...",
  "bytes": "int",
  "lines": "int",
  "symbols": ["function foo", "class Bar", ...],
  "imports_exports": ["...", ...],
  "schema": { "top_level_keys": [...], "depth": "int" },
  "token_estimate": { "raw": "int", "compact": "int", "optimized": "int" }
}
```

Payload fields populated per file type (code files: `symbols`, `imports_exports`; data files: `schema`).

---

## `Edit`

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
      "continueOnError": "bool, optional, overrides top-level for this file",
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

| Op | Requires prior Read | Notes |
|---|---|---|
| `replace` | Yes | Errors if `old` not found or non-unique |
| `replace_all` | Yes | Replaces every occurrence; no uniqueness check |
| `insert_at_line` | No | Inserts before the given line; shifts subsequent lines down |
| `replace_range` | No | Replaces lines `start..end` inclusive |
| `append` | No | Appends to EOF. Creates file (and parent dirs) if missing. |
| `delete` | Yes | Canonicalizes to `replace → ""` internally; kept as explicit op for readability |
| `create` | No | Fails if file already exists. Auto-creates missing parent directories (mkdir -p). Empty `content` produces empty file. |
| `overwrite` | No | Replaces full file content regardless of prior state. Auto-creates file + parents if missing. Empty `content` truncates file. |

Ops within a file execute sequentially; each sees the post-previous-op state. Line-based ops after content-based ops should expect possible line drift.

### Output

Every successful op carries a short `summary` string (always, cheap). `diff` is included only when `returnDiff` is set.

```json
{
  "results": [
    {
      "path": "...",
      "diff": "unified diff for whole file, present only if returnDiff == 'per_file'",
      "ops": [
        { "index": 0, "status": "ok",
          "summary": "replaced 1 occurrence at line 42 (3 chars → 5 chars)",
          "diff": "unified diff, present only if returnDiff == 'per_op'" },
        { "index": 1, "status": "error", "reason": "not_found",
          "hint": { "nearest_line": 42, "next_action": "re-read lines 30-60" } }
      ]
    }
  ]
}
```

### `summary` field conventions (per op type)

| Op | Summary example |
|---|---|
| `replace` | `"replaced 1 occurrence at line 42"` |
| `replace_all` | `"replaced 7 occurrences (lines 12, 18, 34, ...)"` |
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
  "reason": "not_found | ambiguous | file_missing | file_exists | invalid_range",
  "hint": {
    "nearest_line": "int, optional",
    "match_lines": "[int, ...], optional",
    "next_action": "string, human-readable"
  }
}
```

- `not_found`: `hint.nearest_line` populated if similarity > 30%; omit otherwise
- `ambiguous`: `hint.match_lines` lists all matching line numbers
- `file_missing`: target path does not exist (for ops that require it)
- `file_exists`: `create` against existing file
- `invalid_range`: `replace_range` with out-of-bounds or reversed line numbers

### Control flow

- `continueOnError: true` at file level → failed ops don't abort sibling ops in that file
- `continueOnError: true` at top level → failed files don't abort sibling files
- File-level override wins over top-level when both set
- `dryRun: true` → no writes; diffs returned as if applied

---

## Out of scope for v1 (deferred, with revisit triggers)

| Item | Why deferred | Revisit when |
|---|---|---|
| `expected_hash` / stale_read detection | Weak signal; remediation is re-read regardless | Concurrent-write bugs surface in practice |
| Token-based (not line-based) read cap | Current 2000-line cap is token-blind — small files hit cap, huge-narrow files don't | Read truncation becomes a recurring friction |
| `Read` diff mode (content diff vs last read) | Requires server-side state or client-supplied snapshot | Repeated-read workflows become common |
| TOON as an explicit `optimized` opt-in | Benchmark shows dense-flat-only benefit; easy to misuse | Caller has verified data shape is dense + flat |
| File watcher | OS-quirky; hash role already dropped | Undo across external edits becomes a need |
| Undo / inverse-op history | Extra state; unclear demand | "Experiment and revert" flow requested |
| Lossy-transform fidelity metadata | Simpler to start | Agent decisions shown to be misled by `optimized` mode |
| Multi-file atomic rollback | Rarely truly atomic | Real partial-failure pain observed on refactors |
| `regex` edit op | Error-prone, not asked for | Pattern-wide renames become a bottleneck |
| AST/structural edits | Outside token-efficiency focus | Language-aware refactors dominate workload |
| Prompt-cache-aware mode selection | Host-specific | Harness caching model is known |
| Symlink / encoding / CRLF handling spec | Edge cases, low initial volume | Failures observed on Windows or non-UTF-8 files |

---

## Open questions

Resolved this session:

- ~~`FileInfo` — standalone tool or Read mode?~~ → **Read mode** (`mode: "info"`)
- ~~`create` — Edit op or thin standalone tool?~~ → **Edit op**, also fold Write into Edit via `create` + `overwrite`
- ~~`mode` required per request vs default `raw`?~~ → **Required per request**

Still open:

1. **`delete` — explicit op or canonicalize to `replace → ""`?** Current spec: kept as explicit op for log/error clarity; implementation may alias internally.
2. **Info mode depth for large files** — full symbol list vs top-level only with drill-down flag? Tune after usage data.
3. **Diff format** — unified diff vs custom JSON diff? Leans unified (standard, readable).
4. **XML→JSON transform safety heuristic** — what makes XML "data-shaped" enough to auto-convert in `optimized` mode? Likely: no mixed content, attributes only on leaf elements. Needs spec before implementation.

---

## Success criteria

- Typical "read 5 files for context, edit 1 file with 3 ops" workflow: ≥50% token reduction vs current Read/Edit/Write chain
- Edit failure rate on a reference refactor set: no increase vs current Edit
- Follow-up Read calls triggered by edit errors: ≥70% reduction via error hints

---

## Build order

1. `Read` with all three modes, batch input, no `FileInfo` yet
2. `Edit` with `replace`, `replace_all`, `create`, `append`, `insert_at_line`, `replace_range` — no `dryRun` yet
3. Error contract with `nearest_line` and `match_lines` hints
4. `continueOnError` at both levels
5. `dryRun`
6. `FileInfo` (decide standalone vs Read mode first)
7. Measure against success criteria; decide on deferred items based on data
