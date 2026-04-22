# Dogfood Log

Rolling research notes for `batch_file_tools` MCP. One entry per session. Goal: track conflicts, solutions, and tool-call reduction trend vs built-in `Read`/`Edit`/`Write`.

Append new entries at the **top** of the Sessions list (newest first) and add a row to the Metrics table.

## Metrics

| Date | MCP calls | Native equiv (est) | Reduction | Notes |
|---|---|---|---|---|
| 2026-04-23 | 2 | 7 | 3.5x | description refresh + redundancy cleanup (session 4) |
| 2026-04-22 | 4 | 14 | 3.5x | diff rewrite + live compound verify (session 3) |
| 2026-04-22 | 7 | 18 | 2.6x | structuredContent drop + v1.1 smoke (session 2) |
| 2026-04-22 | 5 | 28 | 5.6x | enum rename (session 1) |

Native equiv = what the same workflow would cost using `Read`/`Edit`/`Write` with 1 file or 1 op per call.

## Sessions

### 2026-04-23 (session 4) — description refresh + redundancy cleanup

**Shipped:** Stale tool descriptions in `src/index.ts` refreshed to match the HTML-comment envelope (batch_read was still advertising "meta JSON line"; batch_edit had no result-shape hint). Schema default `continueOnError: false` → `true` to match runtime. `ErrorHint.nearest_line` removed (duplicated `nearest_anchor.start_line/end_line`). `OpResult.index` made optional and dropped in summary/diff modes (ops array is dense + input-ordered there). Dead internal `OpFailure.nearestLine` field and its assignment in `buildNotFound` also cleaned up. 124/124 tests green.

**Open follow-up — custom model-optimized diff:** `jsdiff`'s `structuredPatch` is human-biased — within each hunk it groups all `-` removals first, then all `+` additions, so a multi-site `replace_all` reads as `-X -X -X +Y +Y +Y` instead of interleaved `-X +Y -X +Y -X +Y`. We own the op execution and have before/after state per op, so we can emit a diff shape tuned for model parsing: interleaved old/new pairs with obvious alignment, tunable context (1-line default?), optional per-op attribution inline. Worth a design pass before v2 — would replace `structuredPatch` entirely and drop the `diff` dependency.

---

### 2026-04-22 (session 3) — diff-format rewrite + envelope symmetry

**Starting state:** Session 2 left two known issues: unified-diff output triplicated the absolute file path in its header, and per-op diffs lived inside op JSON meta lines (re-escaping every `\n`). `batch_edit` also kept `structuredContent` while `batch_read` had dropped it — asymmetric.

**Critical review of user-staged commits, then joint redesign:**
- `diffContent` had been switched from `createPatch` to hand-rolled `diffLines(old, new).map(x => prefix + '\t' + x.value).join('')`. Problems: (a) `diffLines` does not hunk — unchanged regions emit as full-content chunks, linear in file size; (b) multi-line chunks got one prefix for the whole block, breaking per-line addressability.
- Edit envelope had been reduced to `JSON.stringify(result)` + `structuredContent`. Every `\n` in a diff re-escaped. Policy depended on the harness preferring `structuredContent`; any client that fell back to `content[]` re-eats the escape regression.

**Changes shipped:**
- `diffContent` → `structuredPatch` with `context: 3`. Hunked unified diff, no filename noise, per-line `-`/`+`/` ` prefixes.
- New `formatEditContent`: one `TextContent` per file, single multi-line `<!-- -->` meta comment (file status + per-op status lines), raw body below (file-level diff first, then labeled `<!-- op N diff -->` / `<!-- op N nearest_anchor, lines X-Y -->` sub-blocks). Collapses to single-line comment when meta is 1 line.
- `structuredContent` dropped on `batch_edit` too — symmetric policy: emit unescaped raw text via `content[]` only.
- Read hint pluralization fix: `Read 1 of 10 lines` now pluralizes `lines` correctly.

**Live compound verification (after MCP reconnect):**
- Setup: one `batch_edit` with `create` × 2 built `live-test-a.txt` (7 lines, triplicate `beta`) and `live-test-b.txt` (`one`…`five`).
- Compound call: `continueOnError: true`, file-level `output: "diff"` per file.
  - File A: `replace "beta"→"XYZ"` (intentional ambiguous), `replace_all "beta"→"BETA"`, `delete "gamma\n"`
  - File B: `replace_range 2-3`, `replace_range 3-4` (intentional overlap), `overwrite`
- Verified:
  - **Ambiguous**: op 0 header — `ambiguous — 'beta' matches 3 locations; use replace_all or narrow the anchor (matches at lines 2, 4, 6)`. `match_lines` inlined, no anchor body (correct — ambiguous doesn't carry a snippet).
  - **Phase-1 overlap**: both `replace_range` errored with `invalid_range — overlaps with op at index N (replace_range X-Y)`; explicit cross-reference on each side.
  - **File-level diff rollup**: single hunked diff per file, raw in the body. File A: `@@ -1,7 +1,6 @@` with 3 `-beta` / 3 `+BETA` + 1 `-gamma`. File B: `@@ -1,5 +1,1 @@` whole-file replacement from `overwrite`.
  - **Per-file separation**: two distinct `TextContent` blocks, each with its own meta + body.
  - **No escape regression**: every `\n` reached the model as a real newline.
- On-disk verify (`batch_read info_verbatim` on both files) matched the diff exactly.

**Ops exercised this session:**

| Op | Count | Tested | Notes |
|---|---|---|---|
| `create` | 2 | yes | fixture setup |
| `replace` | 1 | yes | ambiguous, `match_lines` hint populated |
| `replace_all` | 1 | yes | 3 matches, post-ambiguous continuation |
| `delete` | 1 | yes | single-match removal |
| `replace_range` | 2 | yes | phase-1 overlap, both conflicting ops errored |
| `overwrite` | 1 | yes | phase-3 execution after phase-1 errors |

**Still unexercised:** `dryRun` live (unit-tested — low risk).

**Open follow-ups (carry):**
- Field-redundancy pass from session 2 notes (drop `hint.nearest_line`, `OpResult.index` in non-minimal modes, `OpResult.type` on ok ops) — lower priority now that the prose envelope absorbs most of it.
- v2: `info` mode + `token_estimate`, mode/strategy split, richer `info_compact` transforms, `optimized` strategy, `SessionStart` hook + refined tool descriptions for plugin release.

---

### 2026-04-22 (session 2) — structuredContent drop + v1.1 smoke

**Starting state:** Previous session (same-day, session 1) shipped but didn't live-test four post-MVP changes: #4 two-phase execution (line-addressed ops desc-sorted, all line anchors reference the original buffer); #1 `nearest_anchor` peek window on `not_found`; #3 output verbosity tri-level (`minimal`/`summary`/`diff` at root/file/op, op-wins precedence); #2 per-file `TextContent` envelope. 119/119 unit tests pass, but the live model-facing output was unverified.

**Finding — envelope regression:** First live `batch_read` returned the full `{"results":[{"path":...,"mode_applied":...,"lines":64,"returned_lines":64,"truncated":false,"content":"...\\n..."}]}` JSON blob — pre-#2 shape, with every `\n` re-escaped to `\\n`. The envelope module (`src/lib/envelope.ts`) was correct in isolation. Cause: `src/index.ts` set both `content: formatReadContent(result)` AND `structuredContent: result` on every `CallToolResult`. Claude Code's harness surfaces `structuredContent` to the model in place of `content[]` when both are set, re-wrapping the per-file envelope in a single escaped JSON.

**Change:** Dropped `structuredContent` on both `batch_read` and `batch_edit` responses (`plugins/batch_file_tools/src/index.ts:117-122`), added a 6-line `DO NOT add back` comment pointing at this log. Rebuilt; 119/119 still green.

**Verification after MCP reconnect:**
- Re-read `dogfood-log.md` → received as `{"path":"...","lines":64}\n<raw markdown>` — meta line + unescaped content, one `TextContent` block per file. Envelope win realized.
- Compound smoke test on fresh `smoke-test.txt` (5 lines: `alpha/beta/gamma/delta/epsilon`) with ops `[insert_at_line:1 minimal, replace_range:4-4, replace "gamme", append diff]`, root `output: summary`, `continueOnError: true`:
  - **#4 two-phase desc-sort:** `replace_range 4-4` resolved to the *original* line 4 (`delta`); `insert_at_line 1` resolved to the *original* top — neither saw the other's mutation. Final file: `START / alpha / beta / gamma / DELTA-changed / epsilon / omega`.
  - **#1 `nearest_anchor`:** `replace "gamme"` failed with `hint.nearest_anchor = {start_line:3, end_line:5, content:"beta\ngamma\nDELTA-changed\n"}`. Content is verbatim and directly pasteable as next `old`.
  - **#3 verbosity precedence:** successful `insert_at_line` with op-level `minimal` filtered out of the `ops` array; root `summary` applied to `replace_range` → `{index, type, status, summary}`; failed `replace` always included with `{index, type, status, reason, hint}`; `append` with op-level `diff` returned unified diff inline. File-level `status: "partial"` computed correctly. Op > file > root precedence confirmed.

All four v1.1 capabilities verified live.

**Tool calls:**
- MCP: 4 × `batch_read` + 3 × `batch_edit` (1 server-code edit, 1 fixture create, 1 compound test) = **7 calls**.
- Native equiv: ~12 × `Read` + ~6 × `Edit`/`Write` = **~18 calls**.
- Reduction: **2.6x** — lower than session 1 because 70% of this session was diagnostic reading + server surgery, not bulk rename.

**Ops exercised this session:**

| Op | Count | Tested | Notes |
|---|---|---|---|
| `replace` | 2 | yes | 1 success (`structuredContent` removal in server), 1 intentional typo `gamme` to trigger `nearest_anchor` |
| `create` | 1 | yes | `smoke-test.txt` fixture |
| `insert_at_line` | 1 | yes | phase-1 desc-sort verified (line-1 anchor survived a later op on a higher line) |
| `replace_range` | 1 | yes | phase-1 desc-sort verified (line-4 anchor referenced original buffer) |
| `append` | 1 | yes | phase-2 content-addressed; diff-mode output shape verified |

**Still unexercised:** `overwrite`, `delete`, `replace_all`, `match_lines` hint (for ambiguous anchors), file-level diff rollup mode, overlapping phase-1 range error path, `dryRun`.

**Open follow-ups (carry to next session):**
- **Diff output is unusable as returned** — see Developer / User Notes. Needs: strip `Index:`/`---`/`+++` header rows from diff strings; move per-op diff out of the op's JSON meta into an appended raw segment of the content block.
- Field redundancy audit: drop `hint.nearest_line`, drop `OpResult.index` in summary/diff modes, consider dropping `OpResult.type` on ok ops.
- Exercise file-level diff, `overwrite`/`delete`/`replace_all`, `match_lines` ambiguous path, phase-1 overlap error, `dryRun`.

---

### 2026-04-22 (session 1) — enum rename for default-bias fix

**Blind test:** "Read these two planning docs and summarize." No mode guidance.

**Finding:** Agent reflexively picked `raw` over `compact` for read-to-summarize. Two causes: (1) `compact` description led with "not safe for editing" — read as a warning, not a constraint; (2) description pattern was inconsistent — only `edit` told you *when* to use it, the other two described *what* they do. `raw` felt like the neutral-safe default.

**Change:** Renamed flat enum `raw → info_verbatim`, `compact → info_compact`. Rewrote descriptions so `info_compact` is explicit default, `info_verbatim` is scoped to narrow use case (on-disk formatting matters). `info_` prefix prepositions v1 for the v2 mode/strategy split. Updated source + 2 test files + plan doc; 93/93 tests still pass; `dist/` rebuilt.

**Tool calls:**
- MCP: 3 × `batch_read` (2 + 4 + 2 files) + 2 × `batch_edit` (5 files / 10 ops; 1 file / 10 ops) = **5 calls**
- Native equiv: 8 × `Read` + 20 × `Edit` = **28 calls**
- Pending capability: `info` mode and richer `info_compact` transforms unshipped; not measured yet.

**Ops exercised (21 total across 3 `batch_edit` calls):**

| Op | Count | Tested | Notes |
|---|---|---|---|
| `replace` | 15 | yes | All succeeded first try — byte-exact anchors from `mode=edit` pre-reads |
| `replace_all` | 4 | yes | Deterministic quoted-string swaps in test files |
| `append` | 1 | yes | Changelog at EOF of plan doc |
| `create` | 1 | yes | New dogfood-log.md |
| `insert_at_line` | 0 | no | Unused |
| `replace_range` | 0 | no | Unused |
| `delete` | 0 | no | Unused |
| `overwrite` | 0 | no | Unused |

**Not exercised this session:**
- Error hints (`nearest_line`, `match_lines`) — zero op failures; hint actionability unverified. Needs deliberate failure injection.
- Line-addressed ops — content-anchored flow covered everything. Hypothesis: line ops are higher-leverage for *generating* new code than for *modifying* existing code.
- Control flow (`dryRun`, `returnDiff`, `continueOnError`) — all defaults, agent-side usefulness untested.

**Open follow-ups:**
- Session restart needed for the loaded schema to pick up renamed enum values.
- Watch next session: does the new `info_compact`-as-default description actually change pick behavior, or is the bias deeper than wording?

**Developer / User Notes:**
- Read for edit with line numbers might only be necessary or relevant if edit with line number is used. otherwise info_verbatim might be enough if multi line old / new replace is planned. if only word or phrase replace is targeted even compact might be enough. But depends on what is the goal of all edits.
- Edit by line number must be used from bottom to top otherwise second action will work on an assumped index which already might have shifted due to action one done above it.
- Replace all old with new could use a wildcard path which would increase usage for replacing / renaming single words or phrases in multiple files instead of only multiple places in one file.
- Line numbers format should be a hint somewhere \n42\t = "\n" + line number + "\t" for the model to identify if read for edit with line numbers. Also long running is pattern unique enough?
- Tool result uses too many characters. Due to the fact that a single tool result is returned for all batched read calls the result is a JSON object which will result in escaped characters in the content fields. A "\n" becomes "\\n" which adds a single character to every escaped character in the content string. We need to check if a single tool use can return multiple tool results and output one result per file read which might also help to reduce the risk of hitting max output size per tool result. Also the result type is currently "text" might need to check if that is harness given or if we can provide it in the MCP. The result also includes path, mode_applied, lines, returned_lines, truncated, content if we have one reuslt per tool use then we could append these meta data as a prefix before the content (JSON meta + newline + content) which might be less noise, reduce the espacing overhead and is in line with how models read text because it doesn't really matter if the content is inside the json object or following it.
- File read meta data: mandatory: path, total_lines; optional: start_line, returned_line_count, truncated mght be unecessary because implicit if start_line and returned_line_count is set. 
- Edit/write with consecutive whitespaces should utilize tabs if possible. Less output and in return less input when reading.
- If replace all includes the changes of single replace then the model doesn't need to do it, reduce tool use tokens. Example: `... , {"path": "C:\\Users\\TestUser\\Documents\\test.ts","ops": [{"type": "replace", "old": "describe(\"formatForRead — compact mode\"", "new": "describe(\"formatForRead — info_compact mode\""}, {"type": "replace", "old": "describe(\"formatForRead — raw mode\"", "new": "describe(\"formatForRead — info_verbatim mode\""}, {"type": "replace_all", "old": "\"compact\"", "new": "\"info_compact\""}, {"type": "replace_all", "old": "\"raw\"", "new": "\"info_verbatim\""}]}, ...`
- edit result could use a verbosity flag. current output with all the summaries is nice but doesn't help the model in all situations. Might be better to just have a minimal mode which provides a text "All actions successful in all files" or "All actions successful except the following: JSon Objetc of the files and actions which failed". This might be a better default. Othe rmodes could be details which is the current state like the below example and then the diff mode which is the current plus a diff per action. Also the action index in the result adds overhead, the list is ordered so the can just return the action type in the same order like the input.
    - use: `"files": [{"path": "C:\\Users\\TestUser\\Documents\\test.md", "ops": [{ "type": "replace","old": "| Read mode `raw` — content only, byte-exact (CRLF preserved) | ✅ |\n| Read mode `compact` — strip trailing whitespace + collapse blank-line runs | ✅ |", "new": "| Read mode `info_verbatim` — content only, byte-exact (CRLF preserved) | ✅ |\n| Read mode `info_compact` — strip trailing whitespace + collapse blank-line runs | ✅ |" },{"type": "replace", "old": "- Read modes collapsed from `info | raw | compact | optimized` to `edit | raw | compact` — `info` and `optimized` deferred to v2.\n- `raw` mode no longer carries line numbers; line-numbered reading is now `edit` mode. This matches the actual two use cases (read-to-edit vs read-to-understand) cleaner than the original mode names did.", "new": "- Read modes collapsed from `info | raw | compact | optimized` to `edit | info_compact | info_verbatim` — `info` (metadata) and `optimized` deferred to v2. The `info_` prefix is a stepping stone to the v2 mode/strategy split.\n- `info_verbatim` mode (formerly `raw`) carries no line numbers; line-numbered reading is `edit` mode. The edit/info split matches the actual two use cases (read-to-edit vs read-to-understand) cleaner than the original mode names did." }, { "type": "replace", "old": "\"mode\": \"edit | raw | compact\",", "new": "\"mode\": \"edit | info_compact | info_verbatim\"," }, { "type": "replace", "old": "| Mode | Contract | Line numbers | Use case |\n|---|---|---|---|\n| `edit` | Byte-exact content, each line prefixed `{sourceLineNum}\\t` | Yes | Pre-edit anchor reads (required for `replace` / `replace_all` / `delete`) |\n| `raw` | Byte-exact content, no transformation | No | Verbatim content piping |\n| `compact` | Lossless: strip trailing whitespace on each line, collapse runs of 2+ blank lines to 1 blank line. Leading indent preserved. | No | Scanning / reading to understand |\n\n`offset` + `limit` slice the source file first; `compact` mode compacts the slice (keeps offsets meaningful in source-line terms).", "new": "| Mode | Contract | Line numbers | Use case |\n|---|---|---|---|\n| `edit` | Byte-exact content, each line prefixed `{sourceLineNum}\\t` | Yes | Pre-edit anchor reads (required for `replace` / `replace_all` / `delete`) |\n| `info_compact` | Lossless: strip trailing whitespace on each line, collapse runs of 2+ blank lines to 1 blank line. Leading indent preserved. | No | **Default for info reads.** Scanning / reading to understand — saves tokens while preserving all information. |\n| `info_verbatim` | Byte-exact content, no transformation | No | Info reads when on-disk formatting matters (style/whitespace audits, exact-indent checks). |\n\n`offset` + `limit` slice the source file first; `info_compact` mode compacts the slice (keeps offsets meaningful in source-line terms)." }, { "type": "replace", "old": "\"mode_applied\": \"edit | raw | compact\",", "new": "\"mode_applied\": \"edit | info_compact | info_verbatim\"," }, { "type": "replace", "old": "| **Mode/strategy split** | Refactor flat `mode: edit\\|raw\\|compact` into `mode: edit\\|info` + `strategy: peek\\|raw\\|compact\\|optimized`. Enforce `mode=edit → strategy=raw`. Keeps current call sites working via migration mapping. |", "new": "| **Mode/strategy split** | Refactor flat `mode: edit\\|info_compact\\|info_verbatim` into `mode: edit\\|info` + `strategy: verbatim\\|compact\\|optimized`. Enforce `mode=edit → strategy=verbatim`. Interim `info_` prefix in v1 makes the split near-mechanical. |" }, { "type": "replace", "old": "| **Richer `compact` transforms** | Currently whitespace-only. Add: code comment stripping (language-aware), markdown HTML-comment stripping, JSON pretty→compact. Kept lossless. |", "new": "| **Richer `info_compact` transforms** | Currently whitespace-only. Add: code comment stripping (language-aware), markdown HTML-comment stripping, JSON pretty→compact. Kept lossless. |" }, { "type": "replace", "old": "2. ✅ `batch_read` — `edit` + `raw` modes, batch input, offset/limit", "new": "2. ✅ `batch_read` — `edit` + `info_verbatim` modes, batch input, offset/limit" }, { "type": "replace", "old": "4. ✅ `batch_read` `compact` mode (reordered after edit ops; higher-leverage sequence)", "new": "4. ✅ `batch_read` `info_compact` mode (reordered after edit ops; higher-leverage sequence)" }, { "type": "append", "content": "\n## Changelog\n\n- **2026-04-22** — Renamed read-mode enum from `edit | raw | compact` to `edit | info_compact | info_verbatim`. Flips default bias (reflexive pick lands on `info_compact`, the correct default for reading-to-understand) and prepositions the v1 flat enum for the v2 mode/strategy split. Triggered by a dogfooding mis-pick on turn one: agent picked `raw` over `compact` for a plain read-to-summarize task because \"not safe for editing\" in the old `compact` description read as a warning rather than a constraint.\n"}]}]`
    - result: `{\"results\":[{\"path\":\"C:\\Users\\TestUser\\Documents\\test.md\",\"ops\":[{\"index\":0,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 17 (150 chars → 165 chars)\"},{\"index\":1,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 35 (333 chars → 460 chars)\"},{\"index\":2,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 60 (37 chars → 52 chars)\"},{\"index\":3,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 70 (611 chars → 775 chars)\"},{\"index\":4,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 83 (41 chars → 56 chars)\"},{\"index\":5,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 217 (231 chars → 256 chars)\"},{\"index\":6,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 221 (179 chars → 184 chars)\"},{\"index\":7,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 285 (67 chars → 77 chars)\"},{\"index\":8,\"status\":\"ok\",\"summary\":\"replaced 1 occurrence at line 287 (85 chars → 90 chars)\"},{\"index\":9,\"status\":\"ok\",\"summary\":\"appended 4 lines (EOF was line 300)\"}]}]}`
- if read as compact then the edit might need to search for the old string in a formatted and compacted version to find the correct location. Same for read with line numbers and the edit old string includes the line number, might need to search the old string also with line number stripped. currently the tool will output the nearest match exception which might be okay if we implement the peak read with a range around the to peak loaction. then error closest match at line x would trigger to use peak line X with margin of Y characters / lines which would result in a text snipped with a starting line index and a line count as a short hand note plus the verbatim content. then the model might re-run the edit call with verbatim old string.

---

**Appended 2026-04-22 (session 2) — noticed during live smoke test:**

- **Diff output is unusable as returned.** Per-op diff received this session: `"diff":"Index: <full absolute path>\n===...\n--- \"<full absolute path>\"\n+++ \"<full absolute path>\"\n@@ ..."`. Three copies of the absolute file path before the first hunk = pure noise on small edits. Additionally, per-op diffs live inside the op's JSON meta line (as a `diff` string value), so every `\n` re-escapes to `\\n` and every `\` doubles. File-level diff gets the unescaped-in-content-block treatment but still carries the three-path header. Fix: (a) strip the `Index:`/`---`/`+++` header rows in the formatter — keep only `@@` hunks and changed lines; (b) move per-op diff content out of the JSON meta into an appended raw segment of the content block (multiple text segments per file), so per-op diffs flow through unescaped the same way read content does. Prefer (a)+(b) combined.
- `hint.nearest_line` duplicates information already in `hint.nearest_anchor`. The anchor window carries `start_line`/`end_line` and its content locates the match visually. Drop `nearest_line`; `nearest_anchor` alone is enough.
- `OpResult.index` is positionally redundant in `summary`/`diff` output modes where every op appears in input order. Keep it only in `minimal`-partial responses where the `ops` array is a sparse failure-only subset (index is needed to map back to input).
- `OpResult.type` echoes the input op type on every summary-mode op. The input is ordered and the caller already has the op list. Consider dropping `type` on `status: "ok"` ops; keep only on failures (where the model benefits from immediate correlation without cross-referencing the request).
- `batch_read` envelope `{"path","lines"[,"returned_lines"]}\n<content>` is working well — unescaped content per block, `\n` stays a single character. Meta is minimal. Leave as-is.
