# batch_file_tools

A Claude Code plugin that provides batch-capable file reading and editing via MCP. It replaces individual `Read`, `Edit` and `Write` calls with two multi-file, multi-op tools to cut round-trips, reduce context noise and improve error recovery.

## Why

Every native tool call appends its result to the context window which compounds across the session. Batching N file reads or M edits into a single call cuts round-trips and reduces accumulated context overhead.

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

## Tools

### `batch_read`

`batch_read` reads N files in a single call. Each request specifies a mode that controls how much content is returned.

| Mode | Output | Use for |
|---|---|---|
| `compact` *(default)* | Single-line collapsed, stripped indent and consecutive whitespace | Information gathering and `replace`/`replace_all` anchor — cheapest read; whitespace differences resolved by `batch_edit`'s normalization fallback |
| `verbatim` | Normalized indentation | Full-file `replace`/`replace_all` anchor; sliced reads (`offset`+`count`) include `<!-- Read line X to Y ... -->` header for `replace_range`/`insert_at_line` anchoring |
| `fileinfo` | Metadata (size, lines, mtime, isFile) plus optional `refs[]` | Dependency mapping and pre-read sizing |

Requests also support glob and directory expansion, `offset` and `count` for pagination, and a `searchTerm` parameter for case-insensitive search. Search output format depends on `count`: `count=0` (default) returns each match as `lineNum\tcontent` on a single line; `count>0` returns a `<!-- Line M to N, match at line K -->` block per match with that many context lines. Files with no matches across a call are merged into a single `<!-- No match(es) found -->` output block.

#### Formatting normalization

`batch_read` normalizes indentation in all modes by default. The goal is token efficiency and model accuracy: normalized output mirrors the style distribution most prevalent in code training data, keeping comprehension high at minimum token cost.

Rules applied at read time:

- **Most file types** (TypeScript, JavaScript, CSS, YAML, …): normalized to **2-space indentation**. Two spaces is the dominant style across popular open-source JS/TS repositories and public training datasets; it also halves token cost versus 4-space for deeply nested code.
- **Tab-required file types** (Makefile, …): normalized to **1 tab per indent level**. Tabs carry semantic meaning in these formats and must be preserved.

Project-specific styles — 4-space, 6-space, 3-tab, or any other variant — are normalized on read. Reformatting source files is a mechanical task that belongs to automated tools (Prettier, Black, rustfmt, EditorConfig). Delegating it to the model wastes tokens and context with no accuracy benefit.

**Known tradeoff**: Python (PEP 8: 4 spaces) and Rust (rustfmt: 4 spaces) are canonical exceptions — their training data is majority 4-space, so normalizing to 2-space marginally deviates from their established style. Token savings outweigh the accuracy delta for most tasks.

Disable globally via `BATCH_TOOLS_NORMALIZE_FORMATTING=false` (see [Configuration](#configuration)) when indentation is itself the subject of an edit.

The following example reads three files in a single call, each with a different mode.

```json
{ "requests": [
  { "path": "/src/auth.ts", "mode": "compact" },
  { "path": "/src/user.ts", "mode": "verbatim", "searchTerm": "validateToken" },
  { "path": "/package.json", "mode": "fileinfo" }
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

`stopOnError` is configurable at the root, file and op level. The lowest-defined level takes precedence and the default is to continue on error. Dry-run mode can be enabled server-wide via `BATCH_TOOLS_DRY_RUN` (see [Configuration](#configuration)).

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
| `BATCH_TOOLS_MCP_ANNOTATIONS_USER_AUDIENCE` | `--user-audience` | `false` | Append a compact human-readable summary to each tool result (e.g. `"Read 5 — compact: 3, fileinfo: 2"`). Requires the harness to honour `annotations.audience`; when unsupported the summary is also visible to the model as redundant context. |
| `BATCH_TOOLS_READ_META` | `--read-meta` | `{}` | JSON object merged into the `_meta` field of the `batch_read` tool registration. Use for harness-specific flags, e.g. `{"anthropic/maxResultSizeChars":500000,"anthropic/alwaysLoad":true}`. |
| `BATCH_TOOLS_EDIT_META` | `--edit-meta` | `{}` | JSON object merged into the `_meta` field of the `batch_edit` tool registration. Same format as `BATCH_TOOLS_READ_META`. |
| `BATCH_TOOLS_NORMALIZE_FORMATTING` | `--normalize-formatting` | `true` | Normalize indentation on read (see [Formatting normalization](#formatting-normalization)). Disable when indentation is itself being edited. |
| `BATCH_TOOLS_DRY_RUN` | `--dry-run` | `false` | Run `batch_edit` without writing any files. All ops are validated and results are reported as if changes were applied. |
| `BATCH_TOOLS_MCP_STRUCTURED_CONTENT` | `--mcp-structured-content` | `false` | Include the raw result object as `structuredContent` in tool responses alongside `content[]`. Some harnesses surface `structuredContent` to the model instead of `content[]`, which re-wraps text and escapes newlines — leave disabled unless your harness handles both correctly. |

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