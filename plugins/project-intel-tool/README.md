# project-intel-tool

An MCP server that maintains a persistent structural and semantic map of your project. Every session, a model gets file sizes, line counts, import/export graphs, and purpose summaries for every file — without reading a single one.

> **Predecessor:** Rewrite of the [project-intel CLI plugin](https://github.com/thoeltig/claude-code-toolkit/tree/main/plugins/project-intel) from `claude-code-toolkit`, ported from slash commands to a native MCP server.

---

## The Problem

Every session models start blind into a project maze. Without prior context, they have to read many files to understand the project, and often 80% of that content is irrelevant. Exploration agents read full files to return a summary to the main model, which then has to re-read the same files to actually use the information. This is expensive in tokens and context space before any real work begins.

`project-intel` tries to solve this by storing a persistent knowledge base that gives the model an accurate structural and conceptual overview at session start, so context space is used for the actual task, not for orientation.

---

## Token Savings vs Exploration Agents

Orienting via `query` is significantly cheaper than spawning an exploration agent. The cost difference operates at two levels: the response the parent model receives, and the entire subagent session that exploration requires but `query` does not.

An exploration agent operates under a chain of indirection: the user instructs the main model, the main model delegates to a subagent, and the subagent interprets the task on its own. How narrowly or broadly it searches depends on how clearly intent was communicated at each step. A well-scoped delegation results in a few targeted reads; a vague one triggers wide grep, glob, and file reads across the project structure — anywhere from moderate to high token usage. Either way, the subagent spins up a full session, reads file content across multiple turns, and returns a summary before the main model can act. Even when using a smaller, cheaper model for the subagent, this amounts to hundreds of thousands of tokens per exploration call. And the result is ephemeral: the next session starts blind again.

The table below shows per-lookup averages measured across real sessions on a 68-file project:

| Metric | Explore agent | `query` | Delta |
|---|---|---|---|
| Tool output to parent | ~14,000 chars | ~9,000 chars | ~−35% |
| Subagent cache read tokens | ~577,000 | 0 | −100% |
| Subagent cache write tokens | ~51,000 | 0 | −100% |
| Subagent output tokens | ~3,700 | 0 | −100% |
| Subagent assistant turns | ~5–10 | 0 | −100% |

The subagent token cost is the dominant factor and scales with project size. `query` output also grows with project size but remains a single synchronous call with no spawned session, no file reads, and no multi-turn overhead. The knowledge built during scan is reused across every session, so the orientation cost is paid once rather than repeated on every lookup.

Despite the cost difference, both approaches lead to the same follow-up: in measured sessions, a file read was the next action ~65–67% of the time after both `query` and exploration agents — confirming the orientation quality is equivalent.

---

## What query results enable downstream

The cost comparison above covers the orientation call itself. The downstream effect on which files get read — and how — is equally important.

Each result includes `sizeChars` and `lineCount` before any file is opened. A 50-line file and a 2,000-line file call for different read strategies: full read vs. targeted slice with `offset`+`count`. `imports` and `refs` trace dependency chains without opening neighbors. `summary` and `role` let the model filter irrelevant files before they consume any context at all.

The result is that reads following a `query` are purposeful rather than exploratory: the model reads fewer files, reads them more selectively, and avoids the pattern of reading a file only to discard it as irrelevant. Combined with `batch_read`'s compact and sliced modes, orientation front-loads into the first few turns and the session transitions to editing without the scattered read-then-check-then-discard loop that unguided exploration requires throughout.

---

## Two-Layer Data Model

The tool separates knowledge into two layers with different update frequencies:
- Structural data is always up to date and requires no AI. It captures file path, character count, line count, extracted imports and exports, and inter-file references (the file map), and is refreshed on every session start for all new and changed files.
- Semantic data is populated by AI analysis during scan. It captures an extended summary (~450 chars covering content, purpose, and key information), a role, key technologies, and search tags, and is only updated when scan is explicitly run.

This means the tool is useful from the moment it is installed, because file structure, sizes, and dependency connections are always available even before a scan has been run.

---

## Session Start

The session start hook runs `scanProject` automatically on every session. It detects new, modified, and deleted files via git log or filesystem mtime, writes updated structural data for all changed and new files, marks missing files as deleted in the knowledge base, and then reports status and injects instructions into the model's context.

**What the model receives at session start:**

```
[System message to display to the user]
65 file summaries available, 10 file(s) changed, 1 file(s) without AI analysis

[Assistent message injected into the model's context]
You should always use the 'query' MCP tool to explore the project because it will provide you a token efficient overview of the project structure, file sizes and interconnection between the files. The result will also provide you a quick overview of the used technologies, imports and exports, role and description of each file. The tool is designed to provide you an efficient way to know what files you need for a task without reading the full files.

File map and structural information are always up to date, descriptions might need a reevaluation after file changes to check if the content still matches the summaries: 65 file summaries available, 10 file(s) changed, 1 file(s) without AI analysis
```

**Status fields:** `N file summaries available` counts files with structural data in the knowledge base. `N file(s) changed` counts files where git or mtime shows changes since last scan. Structural data is already updated for these files, but semantic fields (summary, role, technologies) may be stale. `N file(s) without AI analysis` counts files that have structural data only, with semantic fields not yet populated.

If the session start hook fails, for example because the MCP server is not correctly registered or the build is missing, the hook outputs: `Knowledge check failed — Could not check project knowledge status. Most likely an issue with the MCP server.`

---

## MCP Tools

### `query`

Searches the knowledge base by keywords and returns a ranked list of files and directories. It is available immediately, without a prior scan.

**Parameters:**
| Parameter | Description | Default |
|---|---|---|
| `keywords` | Space-separated search terms | (required) |
| `scope` | Limit results to files under this path | All directories |
| `max` | Maximum number of results | 25 |
| `format` | `grouped` or `flat` | `grouped` |
| `role` | Filter by file role: `implementation`, `executable`, `helperScript`, `test`, `configuration`, `build`, `documentation`, `data` | All roles |
| `verbosity` | `full` (all fields), `structure` (size/lines/imports/exports/refs — no summary/technologies), `semantic` (summary/technologies/analysisDelta — no imports/exports/refs/lineCount/sizeChars) | `full` |

**Semantic scoring:** each keyword is matched against multiple fields per file:

| Field | Weight | Available without scan |
|---|---|---|
| Summary | +6 | No |
| Exports | +4 | Yes |
| Imports (source path / package) | +4 | Yes |
| Imports (imported names) | +3 | Yes |
| Path | +4 | Yes |
| Refs | +3 | Yes |
| SearchTags | +3 | No |
| Technologies | +2 | No |
| Role | +2 | No |

When a file has been modified since its last semantic analysis, the scores for semantic fields (summary, role, technologies, searchTags) are multiplied by `min(baseline, current) / max(baseline, current)` — the ratio of file size at analysis time to current size. A small edit barely affects ranking; a near-complete rewrite reduces semantic scores close to zero while leaving structural scores unchanged.

Queries on package names, function names, file names, and import/export identifiers return useful results immediately. Summary, role, technology, and tag scoring activates after running scan.

The `grouped` format organizes results by directory, making it a good choice for understanding subsystems and architecture. Each directory group includes a deduplicated `technologies` list aggregated from all files in that group. The `flat` format returns a single ranked list sorted by relevance score, making it better suited for broad searches across unrelated parts of the project.

Each result includes `sizeChars` and `lineCount`, which the model uses to decide how to read the file (full read, line-range slice, or targeted search) without opening it first. When a file has changed since its last semantic analysis, results also include an `unanalysed:` line (e.g. `unanalysed: +12 lines +340 chars`) as a freshness indicator.

**Output format example:**
```
<!-- src/auth/index.ts (Lines: 142, Chars: 4820) [implementation] | TypeScript, JWT, bcrypt -->
Main authentication module entry point...
unanalysed: +12 lines +340 chars
imports: sign, verify from jwt | hash, compare from bcrypt | Router, Request, Response from express
exports: authenticate, logout, middleware
referenced: src/auth/session.ts, src/auth/token.ts
```
Each connectivity field (`imports`, `exports`, `referenced`, `unanalysed`) is rendered on its own line and omitted when empty.

### `scan`

Runs AI analysis on all new, modified, and unanalyzed files and populates semantic fields.

**Parameters:**
| Parameter | Description | Default |
|---|---|---|
| `scanLocation` | Sub-folder to analyze relative to project root | Entire project |

**What it does:**
1. Calls `scanProject` (same as session start): structural data updated, missing files soft-deleted
2. Collects all files needing AI analysis: new files, modified files, files without semantic data
3. Parses each file to build a dependency graph (imports → refs between files in the scan set)
4. Groups files by import cohesion (union-find) and topologically sorts within each group so dependencies are analyzed before dependents
5. Injects already-analyzed dependencies as additional cross file context into each batch prompt
6. Runs AI analysis per batch (see Scan Modes below)
7. Merges semantic results into `.knowledge/summaries.json`

Files are grouped by import cohesion: files that import each other or share an already-summarized dependency form a component via union-find. Within each component, files are topologically sorted so dependencies come before dependents. Components are packed into batches greedily by token budget; oversized components split in topological order. This ensures files that reference each other are analyzed together and each file's dependencies are visible — either as file content earlier in the same batch or as context summaries from a prior batch.

Only changed and unanalyzed files are processed on each run. Subsequent scans on unchanged projects return immediately. Pass `scanLocation` to re-analyze only a subdirectory, which is faster when actively working in one area.

### `submit_analysis`

Only registered in subagent mode (the default). Used by analysis subagents to write results back into the knowledge base. It serializes concurrent writes so multiple subagents can safely submit in parallel. Not invoked directly.

---

## Scan Modes

Two modes are available, controlled by the `PROJECT_INTEL_TOOL_MCP_SAMPLING` environment variable (default: `false`).

### Subagent mode (default)

When MCP sampling is disabled, scan writes batch files to `.knowledge/batches/` and returns instructions to the main model:

```json
{
  "status": "analysis_required",
  "batchCount": 4,
  "batchFiles": [".knowledge/batches/batch-0.txt", ...],
  "instruction": "Spawn subagents in parallel (5-10 at a time). For each batch file, spawn a subagent with a smaller model (e.g. Haiku) and instruct it: Follow the instructions in the provided file."
}
```

Each batch file contains the compact content of the files to analyse, the summaries of related files as additional context, and a prompt instructing the subagent to use the `submit_analysis` tool to write results. This mode works in all harnesses that support subagents. Alternatively the main agent can process the files and submit the analysis directly.

### Sampling mode (`PROJECT_INTEL_TOOL_MCP_SAMPLING=true`)

When MCP sampling is enabled, scan runs analysis via the MCP sampling protocol and blocks until complete. A smaller, faster model (e.g. Haiku) is invoked per batch without any interaction from the main model. The main model sees only the final result — `"Scan complete. Analysed N file(s) in M batch(es)."` — and its context is not polluted by the analysis work. When `PROJECT_INTEL_TOOL_MCP_PROGRESS=true`, one `notifications/progress` notification is sent per completed batch for harnesses that surface progress to the user.

This mode requires the harness to support MCP sampling. The `submit_analysis` tool is **not** registered in this mode.

---

## What Gets Stored

```json
{
  "src/auth/index.ts": {
    "sizeChars": 4820,
    "lineCount": 142,
    "exports": ["authenticate", "logout", "middleware"],
    "imports": {"jwt": ["sign", "verify"], "bcrypt": ["hash", "compare"], "express": ["Router", "Request", "Response"]},
    "refs": ["src/auth/session.ts", "src/auth/token.ts"],
    "summary": "Main authentication module entry point that exports auth functions and middleware for the Express API. Handles JWT creation, bcrypt password comparison, and session attachment. Acts as the single integration point for all auth consumers.",
    "role": "implementation",
    "technologies": ["TypeScript", "JWT", "bcrypt"],
    "searchTags": ["login", "token", "password", "session"],
    "analysisDelta": "+12 lines +340 chars"
  }
}
```

The top four fields (`sizeChars`, `lineCount`, `exports`, `imports`) are always populated by session start. `imports` is a map of source path or package name to a list of imported names (e.g. `{"zod": ["z"], "src/lib/types.ts": ["SamplingBatch"]}`) for TypeScript/JavaScript; C# namespace keys map to empty arrays. `refs` captures intra-project file path mentions without named bindings: side-effect imports, dynamic `import()`, `require()` calls, and path mentions in markdown or text files. The semantic fields (`summary`, `role`, `technologies`) require scan. `analysisDelta` appears only when the file has been modified since its last semantic analysis. Internal fields (`sizeCharsWhenAnalysed`, `lineCountWhenAnalysed`, `searchTags`) are stored in the knowledge base but excluded from query output.
Knowledge is stored at `.knowledge/summaries.json`. For monorepos or projects with sub-projects that have their own `.knowledge/` directories, query automatically aggregates across all sub-project knowledge bases.

---

## Staleness

Structural data is never stale. Session start always refreshes `sizeChars`, `lineCount`, `exports`, `imports`, and `refs` for all changed files.

Semantic data (summary, role, technologies) can become stale when files change. Two signals indicate this: the session start reports `N file(s) changed`, and individual query results include `analysisDelta` (e.g. `+12 lines +340 chars`) when a file has been modified since its last analysis. A small delta suggests the description is likely still accurate; a large delta suggests a re-scan. The semantic weight penalty in scoring automatically de-prioritizes heavily changed files in results.

Good triggers for a re-scan are when session start reports a significant number of changed files, when query results feel outdated or miss recent additions, or after major structural changes such as a new subsystem or large refactor.

gitignore already defines what is relevant for the project. The include and exclude environment variables let you expand or restrict this further.

---

## When to Use

Use `query` first in these situations:
- When the prompt is vague ("improve the API"), query the relevant term before reading files.
- Before spawning Explore agents — `query` covers most orientation needs at a fraction of the cost.
- When navigating an unfamiliar codebase or large monorepo.
- In multi-session work where knowledge persists without re-exploration.
- In team projects where the committed knowledge base is shared across sessions and teammates.

---

## Comparison to Alternatives

| | project-intel | Grep / Glob | Explore Agent |
|---|---|---|---|
| Input | Concept, package, file connection | Exact string or pattern | Natural language question |
| Reads files | No (metadata only) | No (match lines only) | Yes (full file content) |
| Requires setup | First scan recommended | No | No |
| Persistent | Yes | No | No |
| Finds by concept | Yes (after scan) | No | Yes |
| Token cost | Low | Very low | High |

Without scan, structural queries on packages, imports, file names, and refs work immediately at low cost without any file reads. After scan, semantic queries on summary, role, and technology are also available. Combined, this gives a full overview of any area of the project without opening a single file.

---

## Configuration

All settings are configurable as environment variables or CLI arguments (`--name=value`):

| Variable | CLI arg | Description | Default |
|---|---|---|---|
| `PROJECT_INTEL_TOOL_MCP_SAMPLING` | `--mcp-sampling` | Enable MCP sampling mode | `false` |
| `PROJECT_INTEL_TOOL_MCP_LOGGING` | `--mcp-logging` | Enable MCP logging protocol (stderr fallback otherwise) | `false` |
| `PROJECT_INTEL_TOOL_MCP_PROGRESS` | `--mcp-progress` | Enable MCP progress notifications during scan; sends one `notifications/progress` per completed batch | `false` |
| `PROJECT_INTEL_TOOL_MAX_BATCH_TOKENS` | `--max-batch-tokens` | Max tokens per analysis batch | `50000` |
| `PROJECT_INTEL_TOOL_CHARS_PER_TOKEN` | `--chars-per-token` | Char-to-token ratio for budget estimation | `2.5` |
| `PROJECT_INTEL_TOOL_INCLUDE_PATHS` | `--include` | Comma-separated extra paths to include in scan | |
| `PROJECT_INTEL_TOOL_EXCLUDE_PATHS` | `--exclude` | Comma-separated paths to exclude from scan | |
| `PROJECT_INTEL_TOOL_MCP_ANNOTATIONS_USER_AUDIENCE` | `--user-audience` | Append a compact human-readable summary to tool results (e.g. `"Found 9 knowledge entries"`). Requires the harness to honour `annotations.audience`; when unsupported the summary is also visible to the model as redundant context. | `false` |
| `PROJECT_INTEL_TOOL_MCP_STRUCTURED_CONTENT` | `--mcp-structured-content` | Include raw result objects as `structuredContent` in tool responses alongside `content[]`. Some harnesses surface `structuredContent` instead of `content[]`, which re-wraps text and escapes newlines — leave disabled unless your harness handles both correctly. | `false` |
| `PROJECT_INTEL_TOOL_SCAN_META` | `--scan-meta` | JSON object merged into the `_meta` field of the `scan` tool registration. Use for harness-specific flags, e.g. `{"anthropic/maxResultSizeChars":500000}`. | `{}` |
| `PROJECT_INTEL_TOOL_QUERY_META` | `--query-meta` | JSON object merged into the `_meta` field of the `query` tool registration. Replaces the previously hardcoded `anthropic/maxResultSizeChars` and `anthropic/alwaysLoad` defaults. | `{}` |
| `PROJECT_INTEL_TOOL_SUBMIT_ANALYSIS_META` | `--submit-analysis-meta` | JSON object merged into the `_meta` field of the `submit_analysis` tool registration. Same format as `PROJECT_INTEL_TOOL_QUERY_META`. | `{}` |

---

## Best Practices

For first use, run scan on the full project once and commit `.knowledge/summaries.json` to share with teammates. After that, session start keeps structural data current automatically. Re-run scan after significant changes or when the session start report shows many changed files. Use `scanLocation` to re-analyze only the directory you are working in, which is faster than a full re-scan.

When querying, combine conceptual terms ("authentication session management") with technical identifiers ("jwt", "AuthService") for the best results. Narrow with `scope` when you already know the subsystem. Use `flat` format for cross-module comparisons and `grouped` for an architectural overview.

---

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

## Troubleshooting

**Session start hook fails or reports MCP server error.**  
Build the plugin scripts:
```bash
cd plugins/project-intel-tool/scripts
npm install
npm run build
```
Verify the plugin is correctly registered in your MCP configuration.

**"No knowledge found" error from query.**  
The knowledge directory does not exist. Run scan once to create it, or verify the session start hook ran without errors.

**"No matches found" from query.**  
Try broader or more conceptual keywords. If no scan has been run yet, only structural fields (imports, exports, path, refs) are searchable.

**Query returns irrelevant results.**  
Use `scope` to narrow to a specific directory, or re-scan if semantic summaries are outdated.

**Large project scan taking too long.**  
Use `scanLocation` to scan subdirectories incrementally.

---

## Design Decisions

- **Why structural data before semantic data?** File map, imports, exports, size, and line count require zero AI tokens and rely only on filesystem and AST parsing. They are enough to find the right files in most cases and to decide how to read them efficiently. Semantic data multiplies this further but is not a prerequisite.
- **Why sizeChars and lineCount?** Before reading a file the model knows whether it is 50 lines or 2000 lines. Large files can be read in targeted slices (offset + count) instead of loading the full content into context.
- **Why refs (file map)?** Dependency information lets the model navigate the codebase structurally, identifying which files are related by what they import or export, without reading file content.
- **Why persistent local storage?** Every session starts blind. Without persistence, the same exploration happens repeatedly. With it, knowledge is built once and reused across sessions, users, and teammates. Token savings compound with each session.
- **Why gitignore as the relevance boundary?** gitignore already encodes what matters for the project. Leaning on it avoids duplicating ignore configuration and ensures the knowledge base tracks the same files as version control.
- **Why git-based incremental scanning?** Git history gives accurate per-file modification tracking without stat races. Only changed files are re-analyzed. Non-git projects fall back to filesystem mtime.
- **Why SessionStart hook?** The model starts blind each session. The hook provides immediate knowledge status and explicit instructions to use the query tool first, turning a passive tool into active guidance.
- **Why automatic cleanup?** Query accuracy degrades if summaries reference files that no longer exist. Deleted files are marked as deleted automatically on every session start scan to exclude them when the model uses the query tool.
- **Why cohesion-based batch clustering?** Files that import each other or share an already-summarized dependency are grouped into the same batch via union-find. Within each group, dependencies are analyzed before dependents (topological order). This means when a file is analyzed, its direct dependencies are either present as file content in the same batch or injected as context summaries from a prior batch — giving the analysis model accurate knowledge of what each import does.
- **Why two scan modes?** Subagent mode works in any harness with no special capabilities. Sampling mode eliminates context pollution entirely for harnesses that support it. The default is subagent mode for maximum compatibility.

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