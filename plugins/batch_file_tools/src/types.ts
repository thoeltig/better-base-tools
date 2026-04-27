import { z } from "zod";

export const ReadMode = z.enum([
    "compact",
    "verbatim",
    "verbatim_numbered"
  ])
  .default("compact");
export type ReadMode = z.infer<typeof ReadMode>;

export const Reason = z.enum([
    "not_absolute",
    "not_found",
    "is_directory",
    "not_authorized",
    "ambiguous",
    "invalid_range",
    "not_supported",
    "io_error",
    "unparseable"
  ]);
export type Reason = z.infer<typeof Reason>;

export const FileError = z.object({
    reason: Reason,
    message: z.string(),
  })
  .strict();
export type FileError = z.infer<typeof FileError>;

export const ReadRequest = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    mode: ReadMode
      .describe("compact=DEFAULT for reading-to-understand (lossy: multi-ws collapse, leading-indent strip on non-indent-sensitive langs, JSON minify, blank-run collapse). verbatim=reading when byte-exact on-disk formatting matters (no line numbers). verbatim_numbered=byte-exact + line-numbered; required before edit ops that use line anchors (insert_at_line / replace_range)."),
    offset: z.number().int().min(1).default(1).optional()
      .describe("1-indexed start line"),
    limit: z.number().int().min(1).default(1).optional()
      .describe("Max lines to return"),
  })
  .strict();
export type ReadRequest = z.infer<typeof ReadRequest>;

export const ReadInput = z.object({
    requests: z.array(ReadRequest).min(1),
  })
  .strict();
export type ReadInput = z.infer<typeof ReadInput>;

export const ReadResult = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    mode_applied: ReadMode,
    lines: z.number().int().min(0)
      .describe("Total line count"),
    returned_lines: z.number().int().min(0)
      .describe("Returned line count is either equal to total line count and less for partial reads"),
    truncated: z.boolean()
      .describe("True if offset + limit exceeded the total line count"),
    content: z.string(),
    error: FileError.optional(),
  })
  .strict();
export type ReadResult = z.infer<typeof ReadResult>;

export const ReadOutput = z.object({
    results: z.array(ReadResult).min(1),
  })
  .strict();
export type ReadOutput = z.infer<typeof ReadOutput>;

export const OpType = z.enum([
    "replace",
    "replace_all",
    "insert_at_line",
    "replace_range",
    "write"
  ]);
export type OpType = z.infer<typeof OpType>;

const OpReplace = z.object({
    type: z.literal("replace"),
    old: z.string().min(1)
      .describe("Text to find and replace"),
    new: z.string()
      .describe("Replacement text; use empty to delete text"),
    verbose: z.boolean().optional(),
  })
  .strict();

const OpReplaceAll = z.object({
    type: z.literal("replace_all"),
    old: z.string().min(1)
      .describe("Text to find and replace"),
    new: z.string()
      .describe("Replacement text; use empty to delete text"),
    verbose: z.boolean().optional(),
  })
  .strict();

const OpInsertAtLine = z
  .object({
    type: z.literal("insert_at_line"),
    line: z.number().int().min(1)
      .describe("1-indexed line where to insert text"),
    content: z.string().min(1)
      .describe("Text to insert"),
    verbose: z.boolean().optional(),
  })
  .strict();

const OpReplaceRange = z
  .object({
    type: z.literal("replace_range"),
    start: z.number().int().min(1)
      .describe("1-indexed line where text replace starts"),
    end: z.number().int().min(1)
      .describe("1-indexed line where text replace ends"),
    content: z.string()
      .describe("Replacement text"),
    verbose: z.boolean().optional(),
  })
  .strict();

const OpWrite = z.object({
    type: z.literal("write"),
    mode: z.enum(["append", "overwrite"])
      .describe("'append' adds content to EOF; 'overwrite' replaces full file content. Both auto-create the file and any missing parent directories."),
    content: z.string()
      .describe("Text to write; empty allowed only in overwrite mode (truncates to empty file)"),
    verbose: z.boolean().optional(),
  })
  .strict();

export const EditOp = z.discriminatedUnion("type", [
    OpReplace,
    OpReplaceAll,
    OpInsertAtLine,
    OpReplaceRange,
    OpWrite,
  ]);
export type EditOp = z.infer<typeof EditOp>;

export const EditFile = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path. For `replace`/`replace_all`/`write(append)` ops: also accepts a glob pattern (`*` matches within one path segment; `**` recurses across segments — e.g. `C:/proj/**/*.ts`) or a directory path (single level — use an explicit `**` glob for recursive walks). Other ops require a concrete absolute file path."),
    stopOnError: z.boolean().optional(),
    verbose: z.boolean().optional(),
    ops: z.array(EditOp).min(1)
      .describe("Discriminated by 'type': replace {old,new} | replace_all {old,new} | insert_at_line {line,content} | replace_range {start,end,content} | write {mode,content}. Use replace with new='' to delete matched text. Each op accepts an optional `verbose` boolean."),
  })
  .strict();
export type EditFile = z.infer<typeof EditFile>;

export const EditInput = z.object({
    stopOnError: z.boolean().optional()
      .describe("Stop on first error. Default false (continue): a failed op or file does not skip remaining work. Set true to abort: in-file ops after a failure get status:'skipped'; subsequent files get status:'skipped' when set at root. Resolution within a file: file.stopOnError ?? root.stopOnError ?? false (first defined wins). Across-file abort uses the root flag only; file-level scopes within-file."),
    dryRun: z.boolean().optional()
      .describe("Use to test changes without actually applying them"),
    verbose: z.boolean().optional()
      .describe("Verbosity of output. Default false: response contains failed ops only (plus per-file status). Set true to also include successful ops, each with a summary string. Errors always surface regardless of this flag. Resolution: op.verbose ?? file.verbose ?? root.verbose ?? false (first defined wins; explicit false overrides a higher-level true)."),
    files: z.array(EditFile).min(1),
  })
  .strict();
export type EditInput = z.infer<typeof EditInput>;

export const NearestAnchor = z.object({
    start_line: z.number().int().min(1)
      .describe("1-indexed line where anchor starts"),
    end_line: z.number().int().min(1)
      .describe("1-indexed line where anchor ends"),
    content: z.string().min(1)
      .describe("Nearest possible anchor"),
  })
  .strict();
export type NearestAnchor = z.infer<typeof NearestAnchor>;

export const ErrorHint = z.object({
    nearest_anchor: NearestAnchor.optional(),
    match_lines: z.array(z.number().int().positive()).optional(),
    next_action: z.string(),
  })
  .strict();
export type ErrorHint = z.infer<typeof ErrorHint>;

export const OpStatus = z.enum([
    "ok",
    "error",
    "skipped"
  ]);
export type OpStatus = z.infer<typeof OpStatus>;

export const OpResult = z.object({
    index: z.number().int().min(0).optional(),
    status: OpStatus,
    type: OpType.optional(),
    summary: z.string().optional(),
    reason: Reason.optional(),
    hint: ErrorHint.optional(),
  })
  .strict();
export type OpResult = z.infer<typeof OpResult>;

export const FileStatus = z.enum([
    "ok",
    "partial",
    "error",
    "skipped"
  ]);
export type FileStatus = z.infer<typeof FileStatus>;

export const FileResult = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    status: FileStatus,
    error: FileError.optional(),
    ops: z.array(OpResult),
  })
  .strict();
export type FileResult = z.infer<typeof FileResult>;

export const EditOutput = z.object({
    results: z.array(FileResult).min(1),
  })
  .strict();
export type EditOutput = z.infer<typeof EditOutput>;

export const EditTextInput = z.object({
    content: z.string().min(1)
      .describe("Full text-format edit blob. See tool description for grammar."),
  })
  .strict();
export type EditTextInput = z.infer<typeof EditTextInput>;
