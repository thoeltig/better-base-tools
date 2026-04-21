import { z } from "zod";

/**
 * v1 uses a flat `mode` enum. v2 refactor path: split into
 *   mode: "edit" | "info"
 *   strategy: "peek" | "raw" | "compact" | "optimized"
 * where mode=edit forces strategy=raw.
 */
export const ReadMode = z.enum(["edit", "raw", "compact"]);
export type ReadMode = z.infer<typeof ReadMode>;

export const ReadRequest = z.object({
  path: z.string().min(1),
  mode: ReadMode,
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
export type ReadRequest = z.infer<typeof ReadRequest>;

export const ReadInput = z.object({
  requests: z.array(ReadRequest).min(1),
});
export type ReadInput = z.infer<typeof ReadInput>;

export const ReadResult = z.object({
  path: z.string(),
  mode_applied: z.string(),
  lines: z.number().int().nonnegative(),
  returned_lines: z.number().int().nonnegative(),
  truncated: z.boolean(),
  content: z.string().optional(),
  error: z
    .object({
      reason: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type ReadResult = z.infer<typeof ReadResult>;

export const ReadOutput = z.object({
  results: z.array(ReadResult),
});
export type ReadOutput = z.infer<typeof ReadOutput>;

const OpReplace = z.object({
  type: z.literal("replace"),
  old: z.string(),
  new: z.string(),
});

const OpReplaceAll = z.object({
  type: z.literal("replace_all"),
  old: z.string(),
  new: z.string(),
});

const OpInsertAtLine = z.object({
  type: z.literal("insert_at_line"),
  line: z.number().int().positive(),
  content: z.string(),
});

const OpReplaceRange = z.object({
  type: z.literal("replace_range"),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  content: z.string(),
});

const OpAppend = z.object({
  type: z.literal("append"),
  content: z.string(),
});

const OpDelete = z.object({
  type: z.literal("delete"),
  old: z.string(),
});

const OpCreate = z.object({
  type: z.literal("create"),
  content: z.string(),
});

const OpOverwrite = z.object({
  type: z.literal("overwrite"),
  content: z.string(),
});

export const EditOp = z.discriminatedUnion("type", [
  OpReplace,
  OpReplaceAll,
  OpInsertAtLine,
  OpReplaceRange,
  OpAppend,
  OpDelete,
  OpCreate,
  OpOverwrite,
]);
export type EditOp = z.infer<typeof EditOp>;

export const EditFile = z.object({
  path: z.string().min(1),
  continueOnError: z.boolean().optional(),
  ops: z.array(EditOp).min(1),
});
export type EditFile = z.infer<typeof EditFile>;

export const ReturnDiffMode = z.enum(["none", "per_file", "per_op"]);
export type ReturnDiffMode = z.infer<typeof ReturnDiffMode>;

export const EditInput = z.object({
  continueOnError: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
  returnDiff: ReturnDiffMode.optional().default("none"),
  files: z.array(EditFile).min(1),
});
export type EditInput = z.infer<typeof EditInput>;

export const ErrorReason = z.enum([
  "not_found",
  "ambiguous",
  "file_missing",
  "file_exists",
  "invalid_range",
  "io_error",
]);
export type ErrorReason = z.infer<typeof ErrorReason>;

export const ErrorHint = z.object({
  nearest_line: z.number().int().positive().optional(),
  match_lines: z.array(z.number().int().positive()).optional(),
  next_action: z.string(),
});
export type ErrorHint = z.infer<typeof ErrorHint>;

export const OpResult = z.object({
  index: z.number().int().nonnegative(),
  status: z.enum(["ok", "error", "skipped"]),
  summary: z.string().optional(),
  diff: z.string().optional(),
  reason: ErrorReason.optional(),
  hint: ErrorHint.optional(),
});
export type OpResult = z.infer<typeof OpResult>;

export const FileResult = z.object({
  path: z.string(),
  diff: z.string().optional(),
  ops: z.array(OpResult),
});
export type FileResult = z.infer<typeof FileResult>;

export const EditOutput = z.object({
  results: z.array(FileResult),
});
export type EditOutput = z.infer<typeof EditOutput>;
