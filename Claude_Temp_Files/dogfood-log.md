# Dogfood Log

Sessions 1-8 archived in `dogfood-log-1.md`. Cumulative MCP-vs-native reduction trend lives there.

Append new entries at the **top** of the Sessions list (newest first) and add a row to the Metrics table.

## Metrics

| Date | MCP calls | Native equiv (est) | Reduction | Notes |
|---|---|---|---|---|
| 2026-04-25 | 7 | n/a | n/a | dogfood-only: read-mode token measurement (D) + diff-drop decision (A) (session 9) |

Native equiv = what the same workflow would cost using `Read`/`Edit`/`Write` with 1 file or 1 op per call.

## Open follow-ups

**Queued for session 10 (bundled — all breaking schema changes, one migration round):**
- **Drop `diff` output entirely.** Removes `formatDiff*` / `diffContent`, drops `diff@9.0.0` dep, replaces `output: minimal|summary|diff` enum with `verbose?: boolean` flag at root/file/op (op > file > root precedence preserved). Default `false` = current `minimal`. `true` = current `summary`.
- **Rename `continueOnError` → `stopOnError` + flip default semantic.** New shape: `stopOnError?: boolean, default false` (= continue), `true` = stop. Tests using stop-by-default need `stopOnError: true` added explicitly; tests that set `continueOnError: true` drop the field.

**Active (subsequent sessions):**
- **B — `info` mode (peek):** metadata + per-mode dry-run `{lines, chars}`. Design agreed in session 6.
- **I — `info_optimized` strategy:** lossy data-notation transforms (JSON pretty→compact, XML→JSON, YAML→JSON). User has reusable code. Now sharper-priority after session 9: compact's whitespace-only transforms leave the bulk of data-file savings on the table.

**Deferred:**
- **C — `SessionStart` hook** to replace CLAUDE.md MCP-preference directive. Not needed pre-public-release; user updated CLAUDE.md, observing whether it holds under long planning chains.

**Closed / dropped (session 9 cleanup):**
- E (engines bump `>=22`) — already shipped (`package.json:43`).
- G (glob path normalization) — already shipped (`edit.ts:170` `dedupeKey`).
- F (README MCP-roots note), J (`replace(new='')` summary wording), K (`batch_write` tool — already covered by `write` op), H (glob rollup envelope) — dropped.

**Naming questions, decided in session 9:**
- `output` enum → `verbose` boolean. Implementation in session 10.
- `continueOnError` → `stopOnError` + default semantic flip. See session 9 Q3 below. Bundled into session 10.

## Sessions

### 2026-04-25 (session 9) — read-mode token measurement (D) + diff-drop decision (A)

**Scope:** Two follow-ups from session 8, dogfood-only. No source changes — both items become spec/plan for session 10. Log file split: sessions 1-8 archived to `dogfood-log-1.md`; this is entry one of the new file.

**A — diff drop, decided.**

Honest take after observing my own usage across sessions 1-8: I never picked `output: "diff"` on my own. For every op type, the change is already known to me at call time:
- `replace` / `replace_all` / `delete`: I sent `old` and `new`.
- `write(overwrite)` / `write(append)`: I sent the full new content.
- `insert_at_line`: pure insert, no displaced content.
- `replace_range`: I had to read `verbatim_numbered` to know the range, so I saw the displaced lines there.

Diff is post-hoc proof of work — useful for a human reviewer, not for the model that authored the change. Custom-diff design (carried from session 4) cancelled.

**Plan for session 10:**
1. Remove `diffContent` from `edit.ts` (lines 433-443) and any `formatDiff*` / diff-output paths in the envelope formatter.
2. Drop `diff@9.0.0` from `dependencies` in `package.json`.
3. Replace `output: "minimal" | "summary" | "diff"` enum with `verbose?: boolean` at root/file/op. Op > file > root precedence preserved.
4. Field description (each level): *"Default false: response contains failed ops only (plus per-file status). Set true to also include successful ops, each with a summary string (op type, line, char delta). Errors always surface regardless of this flag."*
5. Drop `OpResult.diff`, `FileResult.diff` from types and tests; remove diff-mode tests; update tool descriptions.
6. Migration is mechanical — every test using `output: "summary"` becomes `verbose: true`. No `output: "diff"` callers exist (we never used it).

**D — read-mode token measurement.**

| File | Lines | Native | verbatim_numbered | verbatim | compact |
|---|---|---|---|---|---|
| `src/tools/edit.ts` (TS) | 509 | 10835 | 9255 | 6309 | 6079 |
| `Claude_Temp_Files/base-tools-plan.md` (MD) | 333 | 9291 | 9289 | 8497 | 8285 |

Step deltas:

| Step | TS Δ | MD Δ |
|---|---|---|
| native → verbatim_numbered | −14.6% | −0.02% |
| verbatim_numbered → verbatim (drop line numbers) | −31.9% | −8.5% |
| verbatim → compact (lossy transforms) | −3.6% | −2.5% |
| **native → compact total** | **−43.9%** | **−10.8%** |

**Findings:**
- **Line-number prefix is the dominant token cost on code reads.** Dropping line numbers saves ~6 tokens/line on TS, ~2.4/line on MD. Asymmetry is BPE-driven: prose tokenizes densely, so a `\n42\t` prefix is a small relative bump; code's symbol-heavy tokenization fragments more around the prefix, inflating the line-number tax.
- **Native `Read`'s cat -n padding tokenizes badly against code (−14.6% to switch to MCP `verbatim_numbered`), neutral against prose (−0.02% on MD).** The MCP envelope's unpadded `{n}\t` is a free win over the built-in for any code read.
- **Compact's lossy transforms add only 2.5–3.6% on real files, not the ~30% theoretical ceiling.** That ceiling lives on dense data notations (pretty-printed JSON, deep YAML, blank-run-heavy text) — `info_optimized` (item I) territory. Compact and optimized serve different file shapes; not redundant.
- **MD compact strips fenced-code-block indents.** Real cost for 2.5% saving (Q1 below).

**Methodology — for future measurements:**
- Native `Read` deduplicates within a session ("File unchanged since last read"); MCP `batch_read` does not. Cross-tool comparisons need a fresh file per call, or measurements skew. Hit this mid-session — had to switch the MD target from `dogfood-log.md` (already read) to `base-tools-plan.md` (fresh).
- Sequential one-call-per-message keeps tool-result token attribution clean in the transcript. Parallel batched calls would mix accounting.

**Q1 — should `.md` join the indent-sensitive list?**
No. Indent-strip on MD prose has zero comprehension cost (token-based reading, not layout-based). Cost concentrates in fenced code blocks: stripped indents make verbatim re-quotes wrong. But (a) extracting code from MDs is rare in this workflow, (b) recovery is one re-read in `verbatim`, (c) the 2.5% saving compounds across every MD read. Net: keep current behavior. Document the caveat in the `compact` description on a future descriptions-pass.

**Q2 — `output` enum vs `verbose` boolean?**
Boolean. After diff-drop, `output` reduces to a 2-state choice; a boolean is more ergonomic at the call site. `verbose` chosen over `summary` (noun-as-flag is awkward + ambiguous on content), over `includeOkOps` / `successSummaries` (longer, awkward at call site). Field name leans on universal CLI convention; description carries the precision.

**Q3 — `continueOnError` rename + default flip?**
Yes, both. New shape: `stopOnError?: boolean, default false` (= continue on error), `true` = stop on first error. Reasoning:
- **Default flip is the substantive change.** Most batch ops are independent — a failed `replace` in a 5-op file shouldn't abort the other 4. Forcing the model to set `continueOnError: true` on every multi-op call adds friction without matching real dependency patterns. Stop should be the exception, opt-in for genuine sequential dependencies (e.g., insert a function then call it later in the same batch).
- **Rename follows from the flip.** With default `false` and the name describing opt-in behavior, convention is preserved. Earlier objection (rename inverts default to `true`, breaking convention) doesn't apply once the semantic flips alongside the rename.
- **Migration:** any test relying on current stop-by-default needs `stopOnError: true` added explicitly; any test currently setting `continueOnError: true` to opt into continue should drop the field. Bundle with session 10's diff drop — both are breaking schema changes, one migration round saves churn.

**Implication for default mode choice (open):**
Compact's value-add over verbatim is 2.5–3.6% on code/prose. The default-bias question — should `verbatim` become the default for source files, with `compact` opt-in for data-shaped files? — is premature without dogfooding signal. Current default (`compact`) is fine for now; revisit if compact's lossiness bites in practice.

**Tool calls (this session):**
- 7 reads total: 2 dogfood-log re-reads (carried from session start), 1 native `Read` on TS, 3 MCP `batch_read` on TS, 1 native `Read` on MD (deduped — switched targets), 3 MCP `batch_read` on MD, 1 `Glob` for fresh MD candidates.
- No source changes; no `batch_edit` calls. Workload not representative of normal sessions.
- 1 file rename + 1 file write at session end (this log).

**Open follow-ups:** see top-of-file Open follow-ups section.
