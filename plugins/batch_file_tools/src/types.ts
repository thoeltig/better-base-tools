import { z } from "zod";

/**
 * v1 uses a flat `mode` enum with an `info_` prefix as a stepping stone to v2.
 * v2 refactor path: formally split into
 *   mode: "edit" | "info"
 *   strategy: "verbatim" | "compact" | "optimized"
 * where mode=edit forces strategy=verbatim.
 */

export const ReadMode = z.enum([
    "edit",
    "info_compact",
    "info_verbatim"
  ])
  .default("info_compact");
export type ReadMode = z.infer<typeof ReadMode>;

export const FileErrorReason = z.enum([
    "not_absolute",
    "not_found",
    "is_directory",
    "not_authorized",
    "io_error"
  ]);
export type FileErrorReason = z.infer<typeof FileErrorReason>;

export const FileError = z.object({
    reason: FileErrorReason,
    message: z.string(),
  })
  .strict();
export type FileError = z.infer<typeof FileError>;

export const ReadRequest = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    mode: ReadMode
      .describe("edit=pre-edit reads (line-numbered, byte-exact). info_compact=default for info reads (lossless compact, saves tokens). info_verbatim=info reads when on-disk formatting matters (byte-exact, no line numbers)." ),
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

export const OutputMode = z.enum([
    "minimal",
    "summary",
    "diff"
  ])
  .default("minimal");
export type OutputMode = z.infer<typeof OutputMode>;

const OpReplace = z.object({
    type: z.literal("replace"),
    old: z.string().min(1)
      .describe("Text to find and replace"),
    new: z.string()
      .describe("Replacement text; use empty to delete text"),
    output: OutputMode.optional(),
  })
  .strict();

const OpReplaceAll = z.object({
    type: z.literal("replace_all"),
    old: z.string().min(1)
      .describe("Text to find and replace"),
    new: z.string()
      .describe("Replacement text; use empty to delete text"),
    output: OutputMode.optional(),
  })
  .strict();

const OpInsertAtLine = z
  .object({
    type: z.literal("insert_at_line"),
    line: z.number().int().min(1)
      .describe("1-indexed line where to insert text"),
    content: z.string().min(1)
      .describe("Text to insert"),
    output: OutputMode.optional(),
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
    output: OutputMode.optional(),
  })
  .strict();

const OpWrite = z.object({
    type: z.literal("write"),
    mode: z.enum(["append", "overwrite"])
      .describe("'append' adds content to EOF; 'overwrite' replaces full file content. Both auto-create the file and any missing parent directories."),
    content: z.string()
      .describe("Text to write; empty allowed only in overwrite mode (truncates to empty file)"),
    output: OutputMode.optional(),
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
      .describe("Absolute path"),
    continueOnError: z.boolean().optional(),
    output: OutputMode.optional(),
    ops: z.array(EditOp).min(1)
      .describe("Discriminated by 'type': replace {old,new} | replace_all {old,new} | insert_at_line {line,content} | replace_range {start,end,content} | write {mode,content}. Use replace with new='' to delete matched text. Each op accepts optional `output: minimal|summary|diff`."),
  })
  .strict();
export type EditFile = z.infer<typeof EditFile>;

export const EditInput = z.object({
    continueOnError: z.boolean().default(true)
      .describe("Continue on error or stop then next ops will be skipped (root default; overridable at file level and op level)"),
    dryRun: z.boolean().optional()
      .describe("Use to test changes without actually applying them"),
    output: OutputMode.optional().default("minimal")    
      .describe("Verbosity of output (root default; overridable at file level and op level): minimal = only success signal and errors, summary = a short message explaining how each op performend, diff = includes summary plus a diff of changed lines"),
    files: z.array(EditFile).min(1),
  })
  .strict();
export type EditInput = z.infer<typeof EditInput>;

export const EditErrorReason = z.enum([
    "not_found",
    "ambiguous",
    "file_missing",
    "invalid_range",
    "io_error",
  ]);
export type EditErrorReason = z.infer<typeof EditErrorReason>;

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
    diff: z.string().optional(),
    reason: EditErrorReason.optional(),
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
    diff: z.string().optional(),
    error: FileError.optional(),
    ops: z.array(OpResult).min(1),
  })
  .strict();
export type FileResult = z.infer<typeof FileResult>;

export const EditOutput = z.object({
    results: z.array(FileResult).min(1),
  })
  .strict();
export type EditOutput = z.infer<typeof EditOutput>;
