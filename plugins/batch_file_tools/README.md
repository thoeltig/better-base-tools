# batch_file_tools

A Claude Code plugin that provides batch-capable file reading and editing via MCP. It replaces individual `Read`, `Edit` and `Write` calls with two multi-file, multi-op tools to cut round-trips, reduce context noise and improve error recovery.

## Why

Every native tool call appends its result to the context window, and that overhead compounds across the session. Batching N file reads or M edits into a single call cuts round-trips and reduces accumulated context overhead.

The following results come from a controlled test that ran an identical 4-task workload with native tools and then again with MCP tools:

| Metric | Delta |
|---|---|
| Tool calls | −58% |
| Cache read tokens | −51% |
| Session duration | −45% |
| Effective input tokens | −46% |

Real-world sessions on actual projects confirm those numbers by showing −57% file I/O calls, −91% lines per read call and −47% context loaded. Two things drive the difference:
- `batch_read` targets only the lines needed rather than loading whole files, pulling 7× less content per read call and keeping the context window from filling prematurely.
- `batch_edit` bundles multiple files and operations into a single turn. Where native tools require one call per change, `batch_edit` averages roughly 5 changes per call. In the controlled test 27 native edit calls shrank to 7 with MCP, accomplishing more work in 74% fewer turns and directly accounting for the −45% improvement in session duration.

The table below shows per-session averages measured across three real projects.

| Project | Read calls | Lines / read call | Edit calls | Changes / edit call | Context loaded |
|---|---|---|---|---|---|
| Documentation project¹ (native) | 6 | 907 | 15 | 1 | 4.7M tokens |
| Frontend project² (native) | 15 | 1,820 | 27 | 1 | 4.3M tokens |
| Frontend project² (MCP) | **11** | **252** | **7** | **~5** | **2.3M tokens** |
| MCP project³ (MCP) | **13** | **290** | **9** | **~4** | **2.8M tokens** |

_¹ Documentation analysis project — content-only workload, pure native. ² Angular frontend project — same codebase, split by whether MCP server was registered. ³ better-base-tools (this repo)._

## Session analysis

This section provides the methodology and detail behind the numbers in [Why](#why). Measurements are from two codebases (68 files and 343 files), 124 main sessions combined. Baseline: `verbatim` mode for reads.

The [With vs without batch tools](#with-vs-without-batch-tools) subsection gives the overall session comparison; the other subsections cover the individual savings drivers.

<details>

<summary>Full native vs batch read & edit tool comparison</summary>

### Single-file reads are already cheaper

Native `Read` prefixes every line with `N\t` — the same verbatim-numbered format regardless of whether slicing is used. `batch_read` places the line range once in the output header, with no per-line markers in any mode.

| | Native `Read` | `batch_read` `verbatim` | `batch_read` `compact` |
|---|---|---|---|
| Format | `N\t` on every line | range in header once | range in header + whitespace stripped |
| chars / equiv-read | 14k–23k | 5k–9k | lower |
| reduction vs native | — | **2.5–2.8×** | **>2.8×** |

This applies to every `batch_read` call including single-file reads with no bundling. 61% of all observed `batch_read` calls were single-file; they still produced 2.5–2.8× fewer chars per read than the native equivalent.

### Bundling scales with codebase size

Both tools accept arrays. When the model bundles multiple files or operations into one call the savings compound on top of the format reduction. Bundling *rate* scales with codebase size; bundling *depth* (avg items per bundled call) is consistent across projects.

| | smaller codebase | larger codebase |
|---|---|---|
| `batch_read` bundling rate | 39% | 62% |
| avg files per bundled `batch_read` call | 2.9× | 2.9× |
| `batch_edit` bundling rate (multi-file) | 26% | 43% |
| avg ops per `batch_edit` call (all calls) | 2.7× | 3.7× |

### Read modes and targeting

| Mode / strategy | Observed share | Use case |
|---|---|---|
| `verbatim` + `offset`+`count` | 42–56% | Line-targeted slice; header carries range for `replace_range` / `insert_at_line` |
| `compact` full file | 21–24% | Information gathering — cheapest full-file read |
| `verbatim` full file | 15–29% | Exact-whitespace anchor for `replace` / `replace_all` |
| `searchTerm` (any mode) | 25–27% | Match-only output; context windows merged into single blocks |

Native `Read` with slicing still emits `N\t` on every returned line. `batch_read` slices with `offset`+`count` emit the range once in the header, achieving the same targeting at lower overhead.

### Edit operations

Content-anchored ops match a string; line-addressed ops target a line number from a preceding sliced read header. Two op types have no native equivalent.

| Op | Observed share | Native equivalent | Anchor |
|---|---|---|---|
| `replace` | 70–77% | `Edit` | `compact` or `verbatim` read |
| `replace_range` | 15–20% | **none** | line range from `verbatim`+`offset`+`count` header |
| `write` | 5–7% | `Write` | — |
| `insert_at_line` | 2% | **none** | line range from `verbatim`+`offset`+`count` header |
| `replace_all` | 1–2% | `Edit` (all occurrences) | `compact` or `verbatim` read |

17–22% of all edit ops (`replace_range` + `insert_at_line`) are only possible via `batch_edit`. A single-file `batch_edit` call with multiple ops still cuts round-trips versus one `Edit` or `Write` call per change.

### Read-before-edit overhead

Native `Edit` requires a preceding `Read` to source the `old_string` anchor — read the file, locate the string, copy it into the call. Correlation analysis across native sessions in the larger codebase shows 46% of native reads to a file were followed by a native edit to the same file. Of those read→edit pairs, 50% occurred within 3 sequential steps, confirming direct setup overhead rather than incidental context gathering.

`batch_edit` eliminates this coupling. The model can just provide the anchor string without reading the file first. In batch-tool sessions, the same-file read-then-edit sequence drops to 2% of `batch_read` calls.

Each edit to a known file costs two round-trips with native tools (one read result + one edit result, both appending to context) but costs one round-trip with batch tools.

### Anchor failures resolve without re-reads

When a native `Edit` anchor fails to match, the only recourse is to re-read the file to locate the correct string and retry — a full round-trip for what may be a typo or a minor whitespace difference.

`batch_edit` applies whitespace-normalized matching before raising an error: tabs, spaces, and collapsed whitespace in the `old` string are matched against the original file content. If normalized matching also fails, the result includes a `nearest_anchor` block containing verbatim context around the closest matching region, ready to paste as the corrected `old` string. The model corrects the anchor and retries in the next turn without re-reading the file.

This matters most in long sessions where files have been modified since the last read: what would be a stale-read error in native tools (requiring a full re-read) is an inline correction in batch tools.

### Single-file edits still benefit

Multi-file bundling compounds the savings, but most `batch_edit` calls target a single file: 74% in the smaller codebase, 57% in the larger. All calls still averaged 2.7× and 3.7× operations per call respectively.

Three changes to one file with native tools means three sequential `Edit` calls — three round-trips, three result blocks added to context. `batch_edit` handles all three in one call with one result block. The turn is the same unit of context cost whether it contains one operation or ten.

### With vs without batch tools

The table below covers sessions from the larger codebase, split by whether batch tools were active. Task complexity varies between sessions, so this is not a controlled test, but the I/O pattern shift is unambiguous.

| | native tools only | with batch tools | Δ |
|---|---|---|---|
| Avg turns / session | 19.5 | 32.3 | +66% |
| Native Read / session | 5.3 | 0.8 | −85% |
| **Native Edit / session** | **14.0** | **0.8** | **−94%** |
| Native Write / session | 1.1 | 0.3 | −73% |
| `batch_read` calls | — | 12.7 (equiv 26.9) | — |
| `batch_edit` calls | — | 4.6 (equiv 16.8) | — |
| Total actual I/O calls | 20.4 | 19.2 | −6% |
| Equiv I/O if all native | 20.4 | **45.6** | **2.4× more work, same calls** |
| Output tokens / session | 24,454 | 45,771 | +87% |
| Cache read / session | 1,309k | 2,480k | +90% |

Same call budget, 2.4× more I/O work completed. Native Edit — the costliest pattern (read file → extract `old_string` → call `Edit`) — dropped 94%. Sessions ran 66% longer, taking on more complex tasks without hitting context limits.

### What the output growth reflects

Output tokens per session grew 87% (24,454 → 45,771) with batch tools active. That increase is work completed, not overhead: context budget that native tools spend on delivering file content is instead available for reasoning and code generation. Output is the work the model produces to accomplish a task; input is the overhead required to produce it. Reducing input to only the relevant portions frees space for more output.

### Orientation compression and cross-session task merging

Before edits can begin, the model needs to orient: read files, understand structure, build enough context to reason about what to change. With native tools, orientation at session start can fill half the context window just to establish what is there and what needs to be done. While editing, the model also has to `Read` each file before calling `Edit` because its view of the file may be stale. Orientation and edit-setup reads are interleaved throughout, consuming context budget continuously.

With batch tools, orientation uses fewer tokens before editing can start, and edits no longer require a preceding read. In the larger codebase after switching to batch tools, each session covered 25.8 equivalent file reads per session vs 19.0 before, in 13 actual calls vs 15 — 36% broader coverage at lower per-call cost.

The downstream effect is that tasks which previously required multiple sessions — each needing the context window to fill before execution could begin — can now complete in one. With more context space available and fewer turns needed per action, the model accomplishes more within a single session.

Lightweight discovery reduces this further. A `searchTerm` read across a glob locates the relevant code without delivering whole files, and [project-intel-tool](../project-intel-tool/README.md) returns semantic summaries, roles, and dependency maps across the entire project in one query. Both let the model identify which files are worth reading before any content enters the context window, eliminating blind reads of files that turn out to be irrelevant to the task.

### Total native projection vs actual (both codebases combined)

| | Actual calls | Native-equivalent | Saved |
|---|---|---|---|
| `batch_read` | 1,136 | 2,220 | 1,084 (49%) |
| `batch_edit` | 456 | 1,398 | 942 (67%) |
| Native tools (Read / Edit / Write / Grep / Glob) | 1,134 | 1,134 | — |
| **Total** | **2,726** | **4,752** | **2,026 (43%)** |

### Error rates

Native tool errors increase with codebase size and session length. Batch tool error rates are constant.

| Tool | smaller codebase | larger codebase |
|---|---|---|
| Native `Write` | 18% | 28% |
| Native `Edit` stale-read | 0% | 7% |
| `batch_read` | 1% | 1% |
| `batch_edit` | 1% | 1% |

Native `Edit` stale-read errors occur when a file changes between the read and the edit call — a window that grows with session length. `batch_edit` completes the read and write atomically within the same call, eliminating the window.

### Context window impact

Tool results accumulate in the context window with every turn. The reductions above compound:

| Driver | Effect |
|---|---|
| 2.5–2.8× fewer chars per read | context fills proportionally more slowly; more turns fit before limits |
| 43% fewer total I/O calls | fewer result blocks per session |
| 66% more turns in batch sessions | longer sessions completing more work without truncation |
| `replace_range` / `insert_at_line` | eliminate a full-file re-read before targeted edits, removing one round-trip per targeted change |

A 20-file-read, 15-edit session using native tools adds roughly 600k–800k chars of tool results to context. The equivalent session via batch tools adds roughly 250k–300k — freeing 350k–500k chars that extend session length.

</details>

## Tools

### `batch_read`

`batch_read` reads N files in a single call. Each request specifies a mode that controls how much content is returned.

| Mode | Output | Use for |
|---|---|---|
| `compact` *(default)* | Single-line collapsed, stripped indent and consecutive whitespace | Information gathering and `replace`/`replace_all` anchor — cheapest read; whitespace differences resolved by `batch_edit`'s normalization fallback |
| `verbatim` | Byte-exact file content | Full-file `replace`/`replace_all` anchor; sliced reads (`offset`+`count`) include `<!-- Read line X to Y ... -->` header for `replace_range`/`insert_at_line` anchoring |

Requests also support glob and directory expansion, `offset` and `count` for pagination, and a `searchTerm` parameter for case-insensitive search (literal string or regex pattern). Search output format depends on `count`: `count=0` (default) returns each match as `lineNum\tcontent` on a single line; `count>0` returns context blocks — nearby windows are merged into one block, single-match blocks are annotated `<!-- Line M to N, match at line K -->`, merged multi-match blocks use `<!-- Line M to N -->` only. Files with no matches across a call are merged into a single `<!-- No match(es) found -->` output block.

The following example reads three files in a single call — a full compact read, a search, and a line-range slice.

```json
{ "requests": [
  { "path": "/src/auth.ts", "mode": "compact" },
  { "path": "/src/user.ts", "mode": "verbatim", "searchTerm": "validateToken" },
  { "path": "/src/config.ts", "mode": "verbatim", "offset": 40, "count": 20 }
]}
```

### `batch_edit`

`batch_edit` applies multiple edits across multiple files in a single call. Operations run in two phases. Line-addressed operations execute first, sorted in descending order by anchor line so that insertions do not shift subsequent anchors. Content-addressed operations follow in input order.

| Op | Description |
|---|---|
| `replace` | Replaces the first occurrence matched by an exact anchor |
| `replace_all` | Replaces all occurrences matched by an exact anchor |
| `insert_at_line` | Inserts content at a specific line number |
| `replace_range` | Replaces a range of lines |
| `write` | Overwrites or appends to a file, creating parent directories as needed |

Anchor matching for `replace` and `replace_all` uses a two-step fallback: exact string match first; if not found, a whitespace-normalized match (tabs, spaces, and newlines collapsed) against the original file content — the matched original text becomes the replacement target. This is what makes `compact` mode output a reliable anchor despite its whitespace stripping. Only if both steps fail is a `nearest_anchor` error returned, containing verbatim context around the closest match pasteable directly as the corrected `old` string.

`stopOnError` is configurable at the root, file and op level. The lowest-defined level takes precedence and the default is to continue on error. Ops that already ran before the failing one are kept and written to disk; the failing op is reported as `error` and everything after it as `skipped`, so the `N/M ops successful` count always matches what landed. Dry-run mode can be enabled server-wide via `BATCH_TOOLS_DRY_RUN` (see [Configuration](#configuration)).

When a path falls outside the allowed directories the tool prompts for authorization with per-file options to allow access once or for the remainder of the session.

The following example applies three changes across two files in a single call.

```json
{ "files": [
  { "path": "/src/auth.ts", "ops": [
    { "type": "replace", "old": "const timeout = 30", "new": "const timeout = 60" },
    { "type": "insert_at_line", "line": 15, "content": "  logger.debug('auth');\n" }
  ]},
  { "path": "/src/config.ts", "ops": [
    { "type": "replace_all", "old": "AUTH_TIMEOUT", "new": "SESSION_TIMEOUT" }
  ]}
]}
```

---

## Configuration

All options can be set via environment variable or command-line argument. Args accept `--<name>=<value>`, `--<name> <value>`, or bare `--<name>` (sets value to `true`). Environment variables take precedence over args.

| Env var | Arg | Default | Description |
|---|---|---|---|
| `BATCH_TOOLS_MCP_LOGGING` | `--mcp-logging` | `false` | Route log output through the MCP logging protocol instead of `console.error`. Some harnesses do not support MCP logging; leave disabled unless yours does. |
| `BATCH_TOOLS_MCP_ANNOTATIONS_USER_AUDIENCE` | `--user-audience` | `false` | Append a compact human-readable summary to each tool result (e.g. `"Read 5 — compact: 3, verbatim: 2"`). Requires the harness to honour `annotations.audience`; when unsupported the summary is also visible to the model as redundant context. |
| `BATCH_TOOLS_READ_META` | `--read-meta` | `{}` | JSON object merged into the `_meta` field of the `batch_read` tool registration. Use for harness-specific flags, e.g. `{"anthropic/maxResultSizeChars":500000,"anthropic/alwaysLoad":true}`. |
| `BATCH_TOOLS_EDIT_META` | `--edit-meta` | `{}` | JSON object merged into the `_meta` field of the `batch_edit` tool registration. Same format as `BATCH_TOOLS_READ_META`. |
| `BATCH_TOOLS_DRY_RUN` | `--dry-run` | `false` | Run `batch_edit` without writing any files. All ops are validated and results are reported as if changes were applied. |
| `BATCH_TOOLS_MCP_STRUCTURED_CONTENT` | `--mcp-structured-content` | `false` | Include the raw result object as `structuredContent` in tool responses alongside `content[]`. Some harnesses surface `structuredContent` to the model instead of `content[]`, which re-wraps text and escapes newlines — leave disabled unless your harness handles both correctly. |
| `BATCH_TOOLS_INCLUDE_PATHS` | `--include` | *(empty)* | Comma-separated paths added to the allow list. Accepts absolute, relative (resolved from the server cwd), and `~`-expanded paths; each is canonicalized (symlinks resolved). Grants access outside MCP roots but does **not** override `BATCH_TOOLS_EXCLUDE_PATHS`. |
| `BATCH_TOOLS_EXCLUDE_PATHS` | `--exclude` | *(empty)* | Comma-separated files/folders placed behind an elicitation gate. Takes precedence over the allow list and `--include`: paths inside are **blocked** (returning `not_authorized`) until the user approves them via elicitation, even when inside an allowed root. Approving a folder lifts the gate for its whole subtree. Relative entries apply inside every allowed directory (MCP roots + `--include`); absolute/`~` entries match a fixed location. See [Path Access Control](#path-access-control). |
| `BATCH_TOOLS_MAX_OUTPUT_TOKENS` | `--max-output-tokens` | `75000` | Maximum total formatted `batch_read` output in tokens. When the emitted content exceeds this limit, the overflowing read is truncated at a unit boundary — normal reads at a line boundary (header shows the reduced range, inline `<!-- Truncated at line N of M … -->` marker gives a re-read anchor), search reads at a match-block boundary (`<!-- Truncated: showing first K of M match block(s) … -->`) — and any reads that did not fit at all are listed in a trailing `<!-- Max output reached … -->` note. Set to `0` to disable. |
| `BATCH_TOOLS_CHARS_PER_TOKEN` | `--chars-per-token` | `2.5` | Char-to-token ratio used to convert `BATCH_TOOLS_MAX_OUTPUT_TOKENS` into a character budget. |

### Recommended Claude Code setup

Claude Code keeps its built-in `Read`, `Edit` and `Write` tools registered alongside these, which leaves two overlapping ways to touch a file. Over a long session the model can drift back to the single-file tools and lose the batching benefit. Denying the built-ins removes the choice:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_batch_file_tools_batch_file_tools__batch_read",
      "mcp__plugin_batch_file_tools_batch_file_tools__batch_edit"
    ],
    "deny": [
      "Read",
      "Edit",
      "Write"
    ]
  }
}
```

Use `.claude/settings.json` for a single project or `~/.claude/settings.json` for all of them. Until the built-ins are denied, a `PreToolUse` hook injects a short reminder whenever one of them is called; once they are denied the matcher stops firing and the reminder disappears.

## Path Access Control

`batch_read` and `batch_edit` resolve every requested path to a canonical absolute path (symlinks resolved, `~` expanded, relatives resolved against the server's working directory) and then apply a two-layer allow/deny model on top of the standard MCP roots.

**Allow list** — a path is allowed when it falls inside any of (all merged):
1. MCP roots reported by the harness
2. Positional startup arguments (absolute paths only)
3. `BATCH_TOOLS_INCLUDE_PATHS` — extra directories granted without elicitation; useful for paths outside MCP roots

**Deny list** (`BATCH_TOOLS_EXCLUDE_PATHS`) takes precedence over the allow list. A path inside an excluded file/folder is blocked **even when it sits inside an allowed root or an `--include` path** — allow/include entries never override an exclude. The only way to reach an excluded path is an explicit elicitation approval (see below); if the user declines, or the harness has no elicitation capability, the request returns `not_authorized` and the file is never read from disk.

The decision, per path, is:

1. **Excluded?** → allowed only if the user has approved this exact file (or a covering folder) via elicitation; otherwise prompt / deny.
2. **Not excluded?** → allowed if inside the allow list or a session approval; otherwise prompt / deny.

Excludes are re-resolved on every request against the current allow list. A **relative** exclude (e.g. `.env`, `secrets`) is denied inside *every* MCP root and `--include` path, so a repository-shared config (checked in with the project) protects the same files for every teammate regardless of where the server is launched. **Absolute** and `~` excludes match at their fixed location. Each excluded path is compared by its canonical, symlink-resolved form, and a not-yet-created excluded file is also blocked from being created — an exclude that never exists simply protects nothing until the path appears. (One caveat: an exclude naming a path that does not exist yet is held as a literal path; if that exact path is later turned into a symlink, access could slip through. Point excludes at real files/folders to avoid this.)

Access states:

| State | How acquired | Scope |
|---|---|---|
| Configured allow | `BATCH_TOOLS_INCLUDE_PATHS` / positional args | Server lifetime |
| Configured deny | `BATCH_TOOLS_EXCLUDE_PATHS` | Server lifetime; pierced only by elicitation approval |
| One-time allow | Elicitation accepted, no session option selected | Current request only |
| Session allow | Elicitation accepted + "Add file/folder to session" | Rest of session; a folder approval covers all of its descendants |

Read and edit approvals are tracked separately: approving a path for reading does not grant permission to edit it.

## Requirements

This project requires **Node.js >= v22** and the following dependencies:

### Production Dependencies
* `@modelcontextprotocol/sdk` (`1.29.0`) — Model Context Protocol SDK
* `zod` (`3.25.76`) — Schema validation

### Development Dependencies
* `typescript` (`5.9.3`) — Static typing
* `vitest` (`4.1.5`) — Testing framework
* `@types/node` (`25.0.1`) — Type definitions for Node

---

## Version History

See [CHANGELOG.md](./CHANGELOG.md) for complete version history.

## License

See root [LICENSE](./LICENSE) for details.

## Support

- **Issues**: [Report bugs or request features](https://github.com/thoeltig/better-base-tools/issues)
- **Repository**: [better-base-tools](https://github.com/thoeltig/better-base-tools)

---

**Author**: [Thore Höltig](https://github.com/thoeltig)