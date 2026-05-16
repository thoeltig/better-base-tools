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
| `compact` *(default)* | Single-line collapsed, stripped indent and consecutive whitespace | Information gathering, cheapest read |
| `verbatim` | Normalized indentation, no line numbers | Readable content and edit anchors |
| `verbatim_numbered` | Line-numbered (`{n}\t{content}`) | Targeted edits and `insert_at_line` or `replace_range` anchors |
| `fileinfo` | Metadata (size, lines, mtime, isFile) plus optional `refs[]` | Dependency mapping and pre-read sizing |

Requests also support glob and directory expansion, a `searchTerm` parameter that returns matching lines with `count` context lines around each hit, `offset` and `count` for pagination and a `disableNormalizedFormatting` flag to bypass the default indent normalization.

The following example reads three files in a single call, each with a different mode.

```json
{ "requests": [
  { "path": "/src/auth.ts", "mode": "compact" },
  { "path": "/src/user.ts", "mode": "verbatim_numbered", "searchTerm": "validateToken" },
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

When an anchor is not found the error response includes a `nearest_anchor` block containing verbatim context around the closest match which can be pasted directly as the corrected `old` string.

`stopOnError` is configurable at the root, file and op level. The lowest-defined level takes precedence and the default is to continue on error. Setting `dryRun` to true runs the full execution without writing any changes.

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

## Requirements

Requires Node.js 22 or later. Install and build once before first use.

```bash
cd scripts && npm install && npm run build
```

## Installation

Install via the Claude Code plugin system. When the plugin loads and the build is present the `SessionStart` hook injects tool-preference guidance automatically.
To register the MCP server manually add the following to your MCP configuration.

```json
{
  "mcpServers": {
    "batch_file_tools": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/dist/index.js"]
    }
  }
}
```

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