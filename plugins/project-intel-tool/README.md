# project-intel-tool

MCP server that maintains a persistent structural and semantic map of your project. Every session a model gets file sizes, line counts, import/export graphs, purpose and summary for every file, without reading a single file.

> **Predecessor:** Rewrite of the [project-intel CLI plugin](https://github.com/thoeltig/claude-code-toolkit/tree/main/plugins/project-intel) from `claude-code-toolkit`, ported from slash commands to a native MCP server.

---

## The Problem

Every session models start blind into a project maze. Without prior context they has to read many files to understand the project. Often 80% of that content is irrelevant. Exploration agents read full files to return a summary to the main model, which then has to re-read the same files to actually use the information. This is expensive in tokens and context space before any real work begins.

`project-intel` tries to solve this by storing a persistent knowledge base that gives the model an accurate structural and conceptual overview at session start, so context space is used for the actual task, not for orientation.

---

## Two-Layer Data Model

The tool separates knowledge into two layers with different update frequencies.

- **Structural data** is always up to date and requires no AI. It captures file path, character count, line count, extracted imports and exports, and inter-file references (the file map). This layer is written every session start for all new and changed files.
- **Semantic data** is populated by AI analysis during scan. It captures a one-sentence summary, a three-sentence purpose description, a role, and key technologies. This layer is only updated when scan is explicitly run.

This means the tool is useful from the moment it is installed, because file structure, sizes, and dependency connections are always available even before a scan has been run.

---

## Session Start

The session start hook runs `scanProject` automatically on every session. It detects new, modified, and deleted files via git log or filesystem mtime, writes updated structural data for all changed and new files, marks not existing files as deleted in the knowledge base, and then reports status and injects instructions into the model's context.

**What the model receives at session start:**

```
[System message to display to the user]
65 file summaries available, 10 file(s) changed, 1 file(s) without AI analysis

[Assistent message injected into the model's context]
You should always use the 'query' MCP tool to explore the project because it will provide you a token efficient overview of the project structure, file sizes and interconnection between the files. The result will also provide you a quick overview of the used technologies, imports and exports, purpose, role and description of each file. The tool is designed to provide you an efficient way to know what files you need for a task without reading the full files.

File map and structural information are always up to date, descriptions and purpose might need a reevaluation after file changes to check if the content still matches the summaries: 65 file summaries available, 10 file(s) changed, 1 file(s) without AI analysis
```

**Status fields:** `N file summaries available` counts files with structural data in the knowledge base. `N file(s) changed` counts files where git or mtime shows changes since last scan. Structural data is already updated for these files, but semantic fields (summary, purpose) may be stale. `N file(s) without AI analysis` counts files that have structural data only, with semantic fields not yet populated.

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

**Semantic scoring:** each keyword is matched against multiple fields per file:

| Field | Weight | Available without scan |
|---|---|---|
| Purpose | +6 | No |
| Summary | +6 | No |
| Exports | +4 | Yes |
| Imports | +4 | Yes |
| Path | +4 | Yes |
| Refs | +3 | Yes |
| Technologies | +2 | No |
| Role | +2 | No |

When a file has been modified since its last semantic analysis, the scores for semantic fields (purpose, summary, role, technologies) are multiplied by `min(baseline, current) / max(baseline, current)` — the ratio of file size at analysis time to current size. A small edit barely affects ranking; a near-complete rewrite reduces semantic scores close to zero while leaving structural scores unchanged.

Queries on package names, function names, file names, and import/export identifiers return useful results immediately. Purpose and summary scoring activates after running scan.

The `grouped` format organizes results by directory, making it a good choice for understanding subsystems and architecture. Each directory group includes a deduplicated `technologies` list aggregated from all files in that group. The `flat` format returns a single ranked list sorted by relevance score, making it better suited for broad searches across unrelated parts of the project.

Each result includes `sizeChars` and `lineCount`, which the model uses to decide how to read the file (full read, line-range slice, or targeted search) without opening it first. When a file has changed since its last semantic analysis, results also include `analysisDelta` (e.g. `+12 lines +340 chars`) as an inline freshness indicator.

### `scan`

Runs AI analysis on all new, modified, and unanalyzed files and populates semantic fields.

**Parameters:**
| Parameter | Description | Default |
|---|---|---|
| `scanLocation` | Sub-folder to analyze relative to project root | Entire project |

**What it does:**
1. Calls `scanProject` (same as session start): structural data updated, soft delete missing files
2. Collects all files needing AI analysis: new files, modified files, files without semantic data
3. Parses each file to build a dependency graph (imports → refs between files in the scan set)
4. Batches files using topological ordering so dependencies are analyzed before dependents
5. Injects already-analyzed dependencies as additional cross file context into each batch prompt
6. Runs AI analysis per batch (see Scan Modes below)
7. Merges semantic results into `.knowledge/summaries.json`

Files within each topological layer are sorted by directory for folder affinity, then by filename. Batches grow until the estimated token budget is reached, at which point a new batch starts. A layer boundary triggers an early flush if the accumulated batch already exceeds the minimum batch size. This ensures related files land in the same batch and dependencies always precede dependents.

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

Each batch file contains the compact content of the files to analyse, the summaries of the related files as additonal context and a prompt telling the subagent to use the `submit_analysis` tool to write results. This mode works in all harnesses which support subagnets. Alternatively the main agent can process the files and submit the analysis directly.

### Sampling mode (`PROJECT_INTEL_TOOL_MCP_SAMPLING=true`)

When MCP sampling is enabled, scan runs analysis entirely in the background via the MCP sampling protocol. A smaller, faster model (e.g. Haiku) is invoked per batch without any interaction from the main model. The main model sees only the initial return from scan and its context is not polluted by the analysis work.

This mode requires the harness to support MCP sampling. The `submit_analysis` tool is **not** registered in this mode.

---

## What Gets Stored

```json
{
  "src/auth/index.ts": {
    "sizeChars": 4820,
    "lineCount": 142,
    "exports": ["authenticate", "logout", "middleware"],
    "imports": ["jwt", "bcrypt", "express"],
    "refs": ["src/auth/session.ts", "src/auth/token.ts"],
    "summary": "Main authentication module entry point",
    "purpose": "Exports auth functions and middleware for the Express API. Handles JWT creation, bcrypt password comparison, and session attachment. Acts as the single integration point for all auth consumers.",
    "role": "implementation",
    "technologies": ["TypeScript", "JWT", "bcrypt"],
    "analysisDelta": "+12 lines +340 chars"
  }
}
```

The top four fields (`sizeChars`, `lineCount`, `exports`, `imports`) are always populated by session start. `refs` maps intra-project file connections. The semantic fields (`summary`, `purpose`, `role`, `technologies`) require scan. `analysisDelta` appears only when the file has been modified since its last semantic analysis. Internal baseline fields (`sizeCharsWhenAnalysed`, `lineCountWhenAnalysed`) are stored in the knowledge base but never surfaced in query output.
Knowledge is stored at `.knowledge/summaries.json`. For monorepos or projects with sub-projects that have their own `.knowledge/` directories, query automatically aggregates across all sub-project knowledge bases.

---

## Staleness

Structural data is never stale. Session start always refreshes `sizeChars`, `lineCount`, `exports`, `imports`, and `refs` for all changed files.

Semantic data (summary, purpose, role, technologies) can become stale when files change. Two signals indicate this: the session start reports `N file(s) changed`, and individual query results include `analysisDelta` (e.g. `+12 lines +340 chars`) when a file has been modified since its last analysis. A small delta suggests the description is likely still accurate; a large delta suggests a re-scan. The semantic weight penalty in scoring automatically de-prioritizes heavily changed files in results.

Good triggers for a re-scan are when session start reports a significant number of changed files, when query results feel outdated or miss recent additions, or after major structural changes such as a new subsystem or large refactor.

gitignore already defines what is relevant for the project. The include and exclude environment variables let you expand or restrict this further.

---

## When to Use

Query first when answering vague prompts ("improve the API" → query "api" first), before spawning Explore agents, when navigating an unfamiliar codebase or large monorepo, during multi-session work where knowledge persists without re-exploration, and in team projects where committed knowledge is shared across sessions and teammates.

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

Without scan, structural queries on packages, imports, file names, and refs work immediately at low cost without any file reads. After scan, semantic queries on purpose, role, and technology are also available. Combined, this gives a full overview of any area of the project without opening a single file.

---

## Configuration

All settings are configurable as environment variables or CLI arguments (`--name=value`):

| Variable | CLI arg | Description | Default |
|---|---|---|---|
| `PROJECT_INTEL_TOOL_MCP_SAMPLING` | `--mcp-sampling` | Enable MCP sampling mode | `false` |
| `PROJECT_INTEL_TOOL_MCP_LOGGING` | `--mcp-logging` | Enable MCP logging protocol (stderr fallback otherwise) | `false` |
| `PROJECT_INTEL_TOOL_MAX_BATCH_TOKENS` | `--max-batch-tokens` | Max tokens per analysis batch | `50000` |
| `PROJECT_INTEL_TOOL_MIN_BATCH_TOKENS` | `--min-batch-tokens` | Min batch size before layer-boundary flush | `3200` |
| `PROJECT_INTEL_TOOL_CHARS_PER_TOKEN` | `--chars-per-token` | Char-to-token ratio for budget estimation | `2.5` |
| `PROJECT_INTEL_TOOL_INCLUDE_PATHS` | `--include` | Comma-separated extra paths to include in scan | |
| `PROJECT_INTEL_TOOL_EXCLUDE_PATHS` | `--exclude` | Comma-separated paths to exclude from scan | |

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
- **Why automatic cleanup?** Query accuracy degrades if summaries reference files that no longer exist. Deleted files are marked as deleted automatically on every session start scan to exclude them when the models uses the query tool.
- **Why topological batch ordering?** When a file depends on another, the dependency's summary is injected as context into the dependent's analysis prompt. Summaries are therefore written with knowledge of what their imports do, producing more accurate purpose and connection descriptions.
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