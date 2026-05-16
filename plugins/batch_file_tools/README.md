# batch_file_tools

Claude Code plugin providing batch-capable file reading and editing via MCP. Replaces individual `Read`/`Edit`/`Write` calls with two multi-file, multi-op tools — fewer round-trips, less context noise, better error recovery.

## Why

Every native tool call appends its result to the context window, compounding across the session. Batching N file reads or M edits into a single call cuts round-trips and reduces accumulated context overhead.

**Controlled test — identical 4-task workload, MCP vs native tools:**

| Metric | Delta |
|---|---|
| Tool calls | −58% |
| Cache read tokens | −51% |
| Session duration | −45% |
| Effective input tokens | −46% |

Real-world sessions: ~50% tool call reduction, ~15% cache_read reduction.

## Tools

### `batch_read`

Read N files in one call. Select a mode per file:

| Mode | Output | Use for |
|---|---|---|
| `compact` *(default)* | Single-line collapsed, stripped indent + consecutive whitespace | Information gathering — cheapest read |
| `verbatim` | Normalized indentation, no line numbers | Readable content, edit anchors |
| `verbatim_numbered` | Line-numbered (`{n}\t{content}`) | Targeted edits, `insert_at_line`/`replace_range` anchors |
| `fileinfo` | Metadata (size, lines, mtime, isFile) + optional `refs[]` | Dependency mapping, pre-read sizing |

Additional:
- Glob and directory path expansion
- `searchTerm` for targeted context extracts (matching lines ± `count` context)
- `offset` + `count` pagination
- `disableNormalizedFormatting` to receive original file indentation

### `batch_edit`

Multi-file, multi-op edits in one call. Ops run in two phases: line-addressed ops first (sorted DESC by anchor line so insertions don't shift each other), then content-addressed ops in input order.

| Op | Description |
|---|---|
| `replace` | Replace first occurrence by exact anchor |
| `replace_all` | Replace all occurrences |
| `insert_at_line` | Insert content at a specific line |
| `replace_range` | Replace a line range |
| `write` | `overwrite` or `append`; auto-creates parent directories |

**Error recovery:** `not_found` errors include a `nearest_anchor` block — verbatim context around the closest match, pasteable as the corrected `old` string.

**Control flow:** `stopOnError` at root / file / op level (first defined wins, default: continue). `dryRun` runs full execution without writing.

**Elicitation:** Prompts for authorization when a path is outside allowed directories, with per-file session-allow options.

## Requirements

- Node.js ≥ 22
- Install and build once before first use:

```bash
cd scripts && npm install && npm run build
```

## Installation

Install via the Claude Code plugin system. The `SessionStart` hook injects tool-preference guidance automatically when the plugin loads and the build is present.

Manual MCP registration:

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

## License

MIT
