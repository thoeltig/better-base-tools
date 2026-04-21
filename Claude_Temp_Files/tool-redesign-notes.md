# Base Tools: Current State & Redesign Notes

> **Status**: This document captures the pre-implementation analysis and design sketches. The shipped v1 contract and v2 roadmap live in `base-tools-plan.md`. Diverges from the final design in two notable ways: (1) tools ended up named `batch_read` / `batch_edit` rather than `ReadFiles` / `Patch`, and (2) the v1 Read mode enum is `edit | raw | compact` (info/outline/optimized deferred to v2). Treat this file as the reasoning appendix, not the current spec.

## Read — current behavior

**Does:**
- Absolute path → returns `cat -n` formatted content
- Optional `offset` (start line) + `limit` (line count)
- Handles text, images, PDFs (`pages`, max 20), Jupyter notebooks
- Default 2000 lines

**Gaps / waste:**

| Issue | Impact |
|---|---|
| Line-number prefix always included | Tokens wasted on digits; must be stripped mentally before Edit |
| No content search within file | Forces Grep → Read round-trip |
| No symbol/section anchor ("read `foo()`") | Must Grep for line, then Read with offset |
| No batch read of N files | N files = N calls = N latencies |
| No metadata-only mode (size, line count, hash, mtime) | Can't cheaply probe before expensive Read |
| No outline mode (signatures / headings only) | Forced into full read for structural questions |
| No hash/version returned | No handle for staleness detection in later Edit |
| No byte-range for binary-ish files | Line-based only |
| No encoding signal (UTF-16, BOM) | Silent failures |

## Edit — current behavior

**Does:** exact `old_string` → `new_string` substitution; `replace_all` flag; pre-Read required; errors on non-unique or not-found.

**Gaps / waste:**

| Issue | Impact |
|---|---|
| One edit per call | N changes = N roundtrips |
| No atomic multi-edit or rollback | Partial-failure states on refactors |
| No regex / pattern mode | Verbose exact matches for trivial changes |
| `old_string` must be byte-exact and unique | Large anchors just to disambiguate → token bloat |
| No `insert_before` / `insert_after` / `delete_range` primitives | Must duplicate anchor lines to fake insertion |
| No staleness/hash precondition | Can't guard against concurrent writes |
| No dry-run / preview | Can't cheaply validate before commit |
| Non-unique error is binary (fails or all) | No "show me the matches, let me pick" |
| Success output minimal | No returned diff to verify intent |
| No structural editing ("replace body of `foo`") | Language-agnostic string match only |

## Write — current behavior

**Does:** creates new or overwrites entire file; pre-Read required if exists.

**Gaps / waste:**

| Issue | Impact |
|---|---|
| Full file retransmission for any change | Massive tokens when diff would do |
| Pre-Read required for overwrite | Pure waste when intent is full replacement |
| No append mode | Must Read + Write to append one line |
| No create-if-not-exists guard | Silent clobber risk |
| Overlaps heavily with Edit | Two tools, unclear boundary |

## Cross-cutting gaps

- No **batch** primitive (read N, edit N)
- No **transaction** across files (multi-file refactor = best-effort)
- No **file ops** (move/copy/delete) without shelling out
- No **staleness token** flowing from Read → Edit
- No **cost preview** before Read returns
- No **structured diff** in Edit success output

## Chaining semantics — design space

Needed policies for any multi-op tool:

| Mode | When to use |
|---|---|
| `stop` (fail-fast) | Refactors where partial state is broken (rename across imports) |
| `continue` | Broad patches where failures are acceptable and reportable (codemod across 50 files) |
| `rollback` | True transaction: all-or-nothing (risky, needs snapshot) |

Each step must return: `{index, status: ok|err, diff?, error?}` so the agent can reason about partial success without a second round-trip.

## Sketch: redesigned primitives

### 1. `ReadFiles` (batch, metadata-aware)

```
{
  requests: [
    { path, mode: "content"|"outline"|"meta", offset?, limit?, pattern? }
  ]
}
→ [{ path, content?, outline?, meta: {hash, lines, bytes, mtime}, truncated }]
```

- `pattern` returns only matching sections + context (subsumes simple Grep+Read chains)
- `outline` returns structural skeleton (function sigs, headings) for large files
- `hash` is the staleness token passed to Patch

### 2. `Patch` (replaces Edit + Write)

```
{
  path,
  expected_hash?,          // precondition; error if mismatch
  on_error: "stop"|"continue"|"rollback",
  ops: [
    { type: "replace",        anchor: "...",    new: "..." },
    { type: "replace_regex",  pattern: "...",   new: "...", max_matches? },
    { type: "insert_before",  anchor: "...",    content: "..." },
    { type: "insert_after",   anchor: "...",    content: "..." },
    { type: "delete",         anchor: "..." },
    { type: "append",         content: "..." },
    { type: "create",         content: "...",   if_not_exists: true },
    { type: "overwrite",      content: "..." }
  ]
}
→ { file_hash_after, results: [{op_index, status, diff?, error?}] }
```

- One tool, many ops, explicit intent per op
- No forced pre-Read for pure `create`/`overwrite`
- Returns unified diff for verification without another Read

### 3. `BatchPatch` (multi-file)

- Same shape, `files: [Patch, ...]`
- `on_error` applies at file level and op level
- `dry_run: true` returns diffs without writing

## Highest-leverage wins if you only do three

1. **Batch Read with metadata+hash** → kills the Grep→Read→Read chain; enables optimistic concurrency
2. **Multi-op Patch with explicit primitives** (`insert_before`, `delete`, regex) → kills anchor-duplication tokens and round-trip latency
3. **`on_error` + per-op result array** → makes broad codemods safe without external orchestration

---

# Appendix: How other harnesses handle edits

Confidence varies — details below are what I know through Jan 2026. Verify specifics against current docs before committing design decisions.

## Anthropic `text_editor` tool (built-in, used by Claude for computer use / API)

Closest thing to a reference design from Anthropic itself. Commands:

- `view` — accepts `[start_line, end_line]` range
- `create` — new file
- `str_replace` — what Claude Code's `Edit` does
- `insert` — inserts at an explicit `insert_line` number
- `undo_edit` — rolls back the last edit on that file

Already has two primitives Claude Code lacks: **line-addressed insert** and **per-file undo**. Undo is a quiet killer feature for experimentation — lets the agent try an edit, inspect, revert cheaply.

## Aider

Multiple "edit formats" auto-selected by model capability:

- `whole` — full file rewrite
- `diff` / `editblock` — SEARCH/REPLACE blocks (most common)
- `udiff` — unified diff format
- `diff-fenced` — fenced variant

SEARCH/REPLACE block shape:

```
path/file.py
<<<<<<< SEARCH
old content
=======
new content
>>>>>>> REPLACE
```

Notable additions:

- **Architect / editor split**: strong model proposes changes in prose, a cheaper "editor" model translates to SEARCH/REPLACE. Decouples reasoning cost from editing cost.
- **Git-backed**: every edit is a commit → trivial rollback, blame, and diff inspection
- **Multiple blocks per turn** across multiple files

## Cursor "Fast Apply"

Two-model pipeline:

1. Main LLM outputs a *sketch* using `// ... existing code ...` placeholders plus the changed regions
2. A separate fine-tuned "apply" model expands the sketch into a real file edit, using speculative decoding for speed

Tradeoff: adds a model to the pipeline, but main-model tokens drop dramatically for large-file edits. Effective when file context is huge but the change is small.

## OpenAI `apply_patch` (Codex CLI)

Single tool, unified-diff-inspired envelope handling create/update/delete across files in one call:

```
*** Begin Patch
*** Update File: path/a.py
@@ context hunk header
- old line
+ new line
*** Add File: path/b.py
+new file content
*** Delete File: path/c.py
*** End Patch
```

Strength: **one round-trip for N files, N ops**. Weakness: format is picky and LLMs sometimes produce invalid patches.

## Cline / Roo Code

- `apply_diff` — SEARCH/REPLACE blocks (Aider-lineage), multiple blocks per call
- `write_to_file` — full rewrite
- `insert_content` — explicit line number
- `search_and_replace` — regex across file

Proves multi-block single-call is viable in practice.

## SWE-agent

Takes the opposite stance on line numbers:

- `edit <start>:<end> <<EOF ... EOF` — line-range replacement
- Navigation primitives: `goto <line>`, `scroll_up`, `scroll_down`, `search_file <pattern>`
- Argument: line addressing is fine if the agent has buffer-navigation commands, because it never needs to *remember* line numbers across turns — it just navigates fresh

Relevant because it challenges my earlier "never use line numbers" framing. Line numbers work when paired with first-class navigation.

## What's worth stealing

| From | Pattern | Why |
|---|---|---|
| Anthropic text_editor | `undo_edit` | Cheap experimentation, safety net without git |
| Anthropic text_editor | `insert` with line number | Cleaner than anchor-duplication hack |
| Aider | Architect/editor model split | Decouples reasoning cost from edit mechanics |
| Aider | Git-per-edit | Rollback for free, diff inspection built-in |
| Cursor | Sketch + apply model | Huge token savings on large-file edits |
| OpenAI apply_patch | Single envelope, multi-file, multi-op | One round-trip for whole refactors |
| Cline | Multiple diff blocks per call | Already-proven ergonomics |
| SWE-agent | Navigation commands (goto, scroll, search_file) | Reduces Grep→Read→Read chains; makes line numbers safe |

## Design tension to resolve

Two camps:

1. **Content-addressed** (Claude Code Edit, Aider SEARCH/REPLACE): robust to staleness, verbose, can fail on non-uniqueness
2. **Position-addressed** (SWE-agent, text_editor insert): concise, fragile across mutations, needs navigation support

A pragmatic redesign probably supports **both**: content anchors as the default safe path, explicit line ops for when the agent has just read the buffer and wants a cheap insert/delete. `expected_hash` precondition makes the position-addressed path safe against staleness.
