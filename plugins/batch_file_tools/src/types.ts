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
  .default("info_compact")
  .describe("edit=pre-edit reads (line-numbered, byte-exact). info_compact=default for info reads (lossless compact, saves tokens). info_verbatim=info reads when on-disk formatting matters (byte-exact, no line numbers)." );
export type ReadMode = z.infer<typeof ReadMode>;

export const FileErrorReason = z.enum([
    "not_absolute",
    "not_found",
    "is_directory",
    "not_authorized",
    "io_error"
  ])
  .describe("Reason the file access failed");
export type FileErrorReason = z.infer<typeof FileErrorReason>;

export const FileError = z.object({
    reason: FileErrorReason
      .describe("Reason the file access failed"),
    message: z.string()
      .describe("Short explanatory message why file access failed"),
  })
  .strict();
export type FileError = z.infer<typeof FileError>;

export const ReadRequest = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    mode: ReadMode,
    offset: z.number().int().min(1).default(1).optional()
      .describe("1-indexed start line"),
    limit: z.number().int().min(1).default(1).optional()
      .describe("Max lines to return"),
  })
  .strict();
export type ReadRequest = z.infer<typeof ReadRequest>;

export const ReadInput = z.object({
    requests: z.array(ReadRequest).min(1)
      .describe("List of files to reads"),
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
    content: z.string()
      .describe("Read content in requested formatting"),
    error: FileError.optional()
      .describe("Error in case file access failed"),
  })
  .strict();
export type ReadResult = z.infer<typeof ReadResult>;

export const ReadOutput = z.object({
    results: z.array(ReadResult).min(1)
      .describe("List of read files"),
  })
  .strict();
export type ReadOutput = z.infer<typeof ReadOutput>;

export const OpType = z.enum([
    "replace",
    "replace_all",
    "insert_at_line",
    "replace_range",
    "append",
    "delete",
    "create",
    "overwrite"
  ]);
export type OpType = z.infer<typeof OpType>;

export const OutputMode = z.enum([
    "minimal",
    "summary",
    "diff"
  ])
  .default("minimal")
  .describe("Verbosity of output (root default; overridable at file level and op level): minimal = only success signal and errors, summary = a short message explaining how each op performend, diff = includes summary plus a diff of changed lines");
export type OutputMode = z.infer<typeof OutputMode>;

const OpReplace = z.object({
    type: z.literal("replace"),
    old: z.string().min(1)
      .describe("Text to find and replace"),
    new: z.string()
      .describe("Replacement text; use empty to delete text"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  })
  .strict();

const OpReplaceAll = z.object({
    type: z.literal("replace_all"),
    old: z.string().min(1)
      .describe("Text to find and replace"),
    new: z.string()
      .describe("Replacement text; use empty to delete text"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  })
  .strict();

const OpInsertAtLine = z
  .object({
    type: z.literal("insert_at_line"),
    line: z.number().int().min(1)
      .describe("1-indexed line where to insert text"),
    content: z.string().min(1)
      .describe("Text to insert"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
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
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  })
  .strict();

// TODO: Maybe merge append, create and overwrite into one. File level op => Content + enum 'Append' or 'Overwrite'; folder and fiel create happens automatically
const OpAppend = z.object({
    type: z.literal("append"),
    content: z.string().min(1)
        .describe("Text to append"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  })
  .strict();

// TODO: Maybe remove replace and replace_all with empty content handle this
const OpDelete = z.object({
    type: z.literal("delete"),
    old: z.string().min(1)
      .describe("Text to find and delete"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  })
  .strict();

const OpCreate = z.object({
    type: z.literal("create"),
    content: z.string()
      .describe("Text to create file with"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  }).strict();

const OpOverwrite = z.object({
    type: z.literal("overwrite"),
    content: z.string()
      .describe("Text to overwrite file with; use empty to delete all text"),
    output: OutputMode.optional()
      .describe("Verbosity of output; overwrites file level"),
  })
  .strict();

export const EditOp = z.discriminatedUnion("type", [
    OpReplace,
    OpReplaceAll,
    OpInsertAtLine,
    OpReplaceRange,
    OpAppend,
    OpDelete,
    OpCreate,
    OpOverwrite,
  ]) 
  .describe("Discriminated by 'type': replace {old,new} | replace_all {old,new} | insert_at_line {line,content} | replace_range {start,end,content} | append {content} | delete {old} | create {content} | overwrite {content}. Each op accepts optional `output: minimal|summary|diff`.");
export type EditOp = z.infer<typeof EditOp>;

export const EditFile = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    continueOnError: z.boolean().optional()
      .describe("Continue on error or stop then following ops will be skipped; overwrites root level"),
    output: OutputMode.optional() 
      .describe("Verbosity of output; overwrites root level"),
    ops: z.array(EditOp).min(1)
      .describe("List of ops to execute on the file. Will execute line based ops from the bottom up first and then all text anchored ops consecutive."),
  })
  .strict();
export type EditFile = z.infer<typeof EditFile>;

export const EditInput = z.object({
    continueOnError: z.boolean().default(true)
      .describe("Continue on erroror or stop then following ops will be skipped"),
    dryRun: z.boolean().optional()
      .describe("Use to test changes without actually applying them"),
    output: OutputMode.optional().default("minimal")
      .describe("Verbosity of output: minimal = only success signal and errors, summary = a short message explaining how each op performend, diff = includes summary plus a diff of changed lines"),
    files: z.array(EditFile).min(1)
      .describe("List of files to edit"),
  })
  .strict();
export type EditInput = z.infer<typeof EditInput>;

export const EditErrorReason = z.enum([
    "not_found",
    "ambiguous",
    "file_missing",
    "file_exists",
    "invalid_range",
    "io_error",
  ])
  .describe("The reason the edit failed");
export type EditErrorReason = z.infer<typeof EditErrorReason>;

export const NearestAnchor = z.object({
    start_line: z.number().int().min(1)
      .describe("1-indexed line where anchor starts"),
    end_line: z.number().int().min(1)
      .describe("1-indexed line where anchor ends"),
    content: z.string().min(1)
      .describe("Nearest possible anchor text"),
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
  ])
  .describe("Ok = success, error = failed, skipped = previous op stopped on error");
export type OpStatus = z.infer<typeof OpStatus>;

export const OpResult = z.object({
    index: z.number().int().min(0).optional()
      .describe("Index of the op"),
    status: OpStatus
      .describe("Ok = success, error = failed, skipped = previous op stopped on error"),
    type: OpType.optional()
      .describe("Executed type of op"),
    summary: z.string().optional()
      .describe("Explanatory summary of the result"),
    diff: z.string().optional()
      .describe("Diff of the changed content"),
    reason: EditErrorReason.optional()
      .describe("Reason the edit failed"),
    hint: ErrorHint.optional()
      .describe("Error in case the op failed"),
  })
  .strict();
export type OpResult = z.infer<typeof OpResult>;

export const FileStatus = z.enum([
    "ok",
    "partial",
    "error",
    "skipped"
  ])
  .describe("Ok = all ops successfull, partial = some ops failed, error = all ops failed, skipped = previous file stopped on error");
export type FileStatus = z.infer<typeof FileStatus>;

export const FileResult = z.object({
    path: z.string().min(1).max(260)
      .describe("Absolute path"),
    status: FileStatus
      .describe("Ok = all ops successfull, partial = some ops failed, error = all ops failed, skipped = previous file stopped on error"),
    diff: z.string().optional()
      .describe("A diff of the changes if it was requested"),
    error: FileError.optional()
      .describe("Error in case file access failed"),
    ops: z.array(OpResult).min(1)
      .describe("List of executed ops"),
  })
  .strict();
export type FileResult = z.infer<typeof FileResult>;

export const EditOutput = z.object({
    results: z.array(FileResult).min(1)
      .describe("List of edited files"),
  })
  .strict();
export type EditOutput = z.infer<typeof EditOutput>;
