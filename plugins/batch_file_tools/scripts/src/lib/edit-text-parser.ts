import type { EditFile, EditOp } from "../types.js";

export interface ParseError {
  readonly line: number;
  readonly message: string;
}

export interface OpSlotOk {
  readonly status: "ok";
  readonly originalIndex: number;
}

export interface OpSlotUnparseable {
  readonly status: "unparseable";
  readonly originalIndex: number;
  readonly error: ParseError;
}

export type OpSlot = OpSlotOk | OpSlotUnparseable;

export interface ParsedEditFile {
  readonly file: EditFile;
  readonly opSlots: readonly OpSlot[];
}

export type ParseEntry =
  | { readonly kind: "ok"; readonly parsed: ParsedEditFile }
  | { readonly kind: "unparseable"; readonly path: string | undefined; readonly error: ParseError };

export interface ParseResult {
  readonly stopOnError: boolean | undefined;
  readonly dryRun: boolean | undefined;
  readonly verbose: boolean | undefined;
  readonly entries: readonly ParseEntry[];
  readonly rootError: ParseError | undefined;
}

const ACTIONS: ReadonlySet<string> = new Set([
  "replace",
  "replace_all",
  "insert_at_line",
  "replace_range",
  "write",
]);
const ACTION_SCALARS: ReadonlySet<string> = new Set(["line", "start", "end", "mode", "verbose", "stopOnError"]);
const ROOT_SCALARS: ReadonlySet<string> = new Set(["stopOnError", "dryRun", "verbose"]);
const FILE_SCALARS: ReadonlySet<string> = new Set(["stopOnError", "verbose"]);

const RE_FILE = /^File:\s*(.*?)\s*$/;
const RE_ACTION = /^Action:\s*(.*?)\s*$/;
const RE_SCALAR = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/;
const RE_FENCE_OPEN_OLD = /^<<<OLD(?:#(\S+))?\s*$/;
const RE_FENCE_OPEN_NEW = /^<<<NEW(?:#(\S+))?\s*$/;
const RE_FENCE_CLOSE_OLD = /^OLD(?:#(\S+))?>>>\s*$/;
const RE_FENCE_CLOSE_NEW = /^NEW(?:#(\S+))?>>>\s*$/;

interface Ctx {
  readonly lines: string[];
  cursor: number;
}

export function parseEditText(text: string): ParseResult {
  const ctx: Ctx = { lines: text.split("\n"), cursor: 0 };
  const root: { stopOnError?: boolean; dryRun?: boolean; verbose?: boolean } = {};
  const entries: ParseEntry[] = [];
  let rootError: ParseError | undefined;

  while (!atEof(ctx)) {
    const line = peek(ctx);
    if (isBlank(line)) {
      advance(ctx);
      continue;
    }
    if (isIndented(line)) {
      if (!rootError) {
        rootError = { line: lineNo(ctx), message: `unexpected indented line before File:` };
      }
      advance(ctx);
      continue;
    }
    if (RE_FILE.test(line)) break;

    const scalarM = RE_SCALAR.exec(line);
    if (scalarM && ROOT_SCALARS.has(scalarM[1]!)) {
      const v = parseBoolean(scalarM[2]!);
      if (v === undefined) {
        if (!rootError) {
          rootError = { line: lineNo(ctx), message: `expected boolean for ${scalarM[1]} (use 'true' or 'false')` };
        }
      } else {
        root[scalarM[1] as "stopOnError" | "dryRun" | "verbose"] = v;
      }
      advance(ctx);
      continue;
    }

    if (!rootError) {
      rootError = {
        line: lineNo(ctx),
        message: `unexpected line before File:: ${truncate(line)}`,
      };
    }
    advance(ctx);
  }

  if (atEof(ctx) && entries.length === 0) {
    if (!rootError) {
      rootError = { line: 1, message: "no File: header found" };
    }
  }

  while (!atEof(ctx)) {
    const line = peek(ctx);
    if (isBlank(line)) {
      advance(ctx);
      continue;
    }
    if (isIndented(line)) {
      advance(ctx);
      continue;
    }
    const fileM = RE_FILE.exec(line);
    if (!fileM) {
      advance(ctx);
      continue;
    }
    const headerLineNo = lineNo(ctx);
    const path = fileM[1]!;
    advance(ctx);

    if (path === "") {
      entries.push({
        kind: "unparseable",
        path: undefined,
        error: { line: headerLineNo, message: "File: header missing path" },
      });
      skipToNextFile(ctx);
      continue;
    }

    entries.push(parseFile(ctx, path));
  }

  return {
    stopOnError: root.stopOnError,
    dryRun: root.dryRun,
    verbose: root.verbose,
    entries,
    rootError,
  };
}

function parseFile(c: Ctx, path: string): ParseEntry {
  const fileScalars: { stopOnError?: boolean; verbose?: boolean } = {};
  const ops: EditOp[] = [];
  const opSlots: OpSlot[] = [];

  while (!atEof(c)) {
    const line = peek(c);
    if (isBlank(line)) {
      advance(c);
      continue;
    }
    if (isIndented(line)) {
      return {
        kind: "unparseable",
        path,
        error: { line: lineNo(c), message: "unexpected indented line in file block" },
      };
    }
    if (RE_FILE.test(line) || RE_ACTION.test(line)) break;

    const scalarM = RE_SCALAR.exec(line);
    if (!scalarM || !FILE_SCALARS.has(scalarM[1]!)) {
      return {
        kind: "unparseable",
        path,
        error: { line: lineNo(c), message: `unexpected line in file block: ${truncate(line)}` },
      };
    }
    const v = parseBoolean(scalarM[2]!);
    if (v === undefined) {
      return {
        kind: "unparseable",
        path,
        error: { line: lineNo(c), message: `expected boolean for ${scalarM[1]}` },
      };
    }
    fileScalars[scalarM[1] as "stopOnError" | "verbose"] = v;
    advance(c);
  }

  while (!atEof(c)) {
    const line = peek(c);
    if (isBlank(line)) {
      advance(c);
      continue;
    }
    if (!isIndented(line) && RE_FILE.test(line)) break;

    const actionM = !isIndented(line) ? RE_ACTION.exec(line) : null;
    if (!actionM) {
      const err: ParseError = {
        line: lineNo(c),
        message: `unexpected line at file level: ${truncate(line)}`,
      };
      opSlots.push({ status: "unparseable", originalIndex: opSlots.length, error: err });
      skipToNextFile(c);
      break;
    }

    const actionType = actionM[1]!;
    const actionLineNo = lineNo(c);
    advance(c);

    const slotIndex = opSlots.length;
    const result = parseAction(c, actionType, actionLineNo);
    if (result.kind === "ok") {
      ops.push(result.op);
      opSlots.push({ status: "ok", originalIndex: slotIndex });
    } else if (result.kind === "unparseable_op") {
      opSlots.push({ status: "unparseable", originalIndex: slotIndex, error: result.error });
    } else {
      opSlots.push({ status: "unparseable", originalIndex: slotIndex, error: result.error });
      skipToNextFile(c);
      break;
    }
  }

  if (ops.length === 0 && opSlots.some((s) => s.status === "unparseable")) {
    const firstErr = opSlots.find((s): s is OpSlotUnparseable => s.status === "unparseable")!;
    return { kind: "unparseable", path, error: firstErr.error };
  }

  const file: EditFile = {
    path,
    ...(fileScalars.stopOnError !== undefined ? { stopOnError: fileScalars.stopOnError } : {}),
    ...(fileScalars.verbose !== undefined ? { verbose: fileScalars.verbose } : {}),
    ops,
  };

  return { kind: "ok", parsed: { file, opSlots } };
}

type ActionResult =
  | { kind: "ok"; op: EditOp }
  | { kind: "unparseable_op"; error: ParseError }
  | { kind: "unparseable_file"; error: ParseError };

function parseAction(c: Ctx, actionType: string, actionLineNo: number): ActionResult {
  if (!ACTIONS.has(actionType)) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: `unknown Action: ${actionType}`,
    });
  }

  const scalars: Record<string, string> = {};
  while (!atEof(c)) {
    const line = peek(c);
    if (isBlank(line)) {
      advance(c);
      continue;
    }
    if (!isIndented(line)) {
      if (RE_FENCE_OPEN_OLD.test(line) || RE_FENCE_OPEN_NEW.test(line)) break;
      if (RE_FILE.test(line) || RE_ACTION.test(line)) {
        return {
          kind: "unparseable_op",
          error: {
            line: actionLineNo,
            message: `Action: ${actionType} has no fence before next ${RE_FILE.test(line) ? "File:" : "Action:"}`,
          },
        };
      }
      const scalarM = RE_SCALAR.exec(line);
      if (scalarM && ACTION_SCALARS.has(scalarM[1]!)) {
        scalars[scalarM[1]!] = scalarM[2]!;
        advance(c);
        continue;
      }
    }
    return collectActionThenError(c, {
      line: lineNo(c),
      message: `unexpected line in Action ${actionType}: ${truncate(line)}`,
    });
  }

  const verbose = scalars["verbose"] !== undefined ? parseBoolean(scalars["verbose"]) : undefined;
  if (scalars["verbose"] !== undefined && verbose === undefined) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: `Action ${actionType}: invalid 'verbose' (use 'true' or 'false')`,
    });
  }

  const stopOnError = scalars["stopOnError"] !== undefined ? parseBoolean(scalars["stopOnError"]) : undefined;
  if (scalars["stopOnError"] !== undefined && stopOnError === undefined) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: `Action ${actionType}: invalid 'stopOnError' (use 'true' or 'false')`,
    });
  }

  if (actionType === "replace" || actionType === "replace_all") {
    return parseReplaceLike(c, actionType, actionLineNo, verbose, stopOnError);
  }
  if (actionType === "insert_at_line") {
    return parseInsertAtLine(c, actionLineNo, scalars, verbose, stopOnError);
  }
  if (actionType === "replace_range") {
    return parseReplaceRange(c, actionLineNo, scalars, verbose, stopOnError);
  }
  if (actionType === "write") {
    return parseWrite(c, actionLineNo, scalars, verbose, stopOnError);
  }
  return { kind: "unparseable_op", error: { line: actionLineNo, message: `unsupported action: ${actionType}` } };
}

function parseReplaceLike(
  c: Ctx,
  actionType: "replace" | "replace_all",
  actionLineNo: number,
  verbose: boolean | undefined,
  stopOnError: boolean | undefined,
): ActionResult {
  const oldFence = parseFence(c, "OLD");
  if (!oldFence.ok) return fenceFailureToActionResult(c, oldFence, actionLineNo);
  const newFence = parseFence(c, "NEW");
  if (!newFence.ok) return fenceFailureToActionResult(c, newFence, actionLineNo);
  if (oldFence.value.length === 0) {
    return {
      kind: "unparseable_op",
      error: { line: actionLineNo, message: `Action ${actionType}: OLD must be non-empty` },
    };
  }
  const op: EditOp = {
    type: actionType,
    old: oldFence.value,
    new: newFence.value,
    ...(verbose !== undefined ? { verbose } : {}),
    ...(stopOnError !== undefined ? { stopOnError } : {}),
  };
  return { kind: "ok", op };
}

function parseInsertAtLine(
  c: Ctx,
  actionLineNo: number,
  scalars: Record<string, string>,
  verbose: boolean | undefined,
  stopOnError: boolean | undefined,
): ActionResult {
  if (scalars["line"] === undefined) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: "insert_at_line: missing required 'line:' scalar",
    });
  }
  const lineNum = parsePositiveInt(scalars["line"]!);
  if (lineNum === undefined) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: `insert_at_line: invalid 'line:' value '${scalars["line"]}' (must be positive integer)`,
    });
  }
  const newFence = parseFence(c, "NEW");
  if (!newFence.ok) return fenceFailureToActionResult(c, newFence, actionLineNo);
  if (newFence.value.length === 0) {
    return {
      kind: "unparseable_op",
      error: { line: actionLineNo, message: "insert_at_line: content must be non-empty" },
    };
  }
  const op: EditOp = {
    type: "insert_at_line",
    line: lineNum,
    content: newFence.value,
    ...(verbose !== undefined ? { verbose } : {}),
    ...(stopOnError !== undefined ? { stopOnError } : {}),
  };
  return { kind: "ok", op };
}

function parseReplaceRange(
  c: Ctx,
  actionLineNo: number,
  scalars: Record<string, string>,
  verbose: boolean | undefined,
  stopOnError: boolean | undefined,
): ActionResult {
  if (scalars["start"] === undefined || scalars["end"] === undefined) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: "replace_range: requires both 'start:' and 'end:' scalars",
    });
  }
  const start = parsePositiveInt(scalars["start"]!);
  const end = parsePositiveInt(scalars["end"]!);
  if (start === undefined || end === undefined) {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: "replace_range: 'start' and 'end' must be positive integers",
    });
  }
  const newFence = parseFence(c, "NEW");
  if (!newFence.ok) return fenceFailureToActionResult(c, newFence, actionLineNo);
  const op: EditOp = {
    type: "replace_range",
    start,
    end,
    content: newFence.value,
    ...(verbose !== undefined ? { verbose } : {}),
    ...(stopOnError !== undefined ? { stopOnError } : {}),
  };
  return { kind: "ok", op };
}

function parseWrite(
  c: Ctx,
  actionLineNo: number,
  scalars: Record<string, string>,
  verbose: boolean | undefined,
  stopOnError: boolean | undefined,
): ActionResult {
  const mode = scalars["mode"];
  if (mode !== "append" && mode !== "overwrite") {
    return collectActionThenError(c, {
      line: actionLineNo,
      message: `write: 'mode:' must be 'append' or 'overwrite' (got '${mode ?? ""}')`,
    });
  }
  const newFence = parseFence(c, "NEW");
  if (!newFence.ok) return fenceFailureToActionResult(c, newFence, actionLineNo);
  if (mode === "append" && newFence.value === "") {
    return {
      kind: "unparseable_op",
      error: { line: actionLineNo, message: "write append: content must be non-empty" },
    };
  }
  const op: EditOp = {
    type: "write",
    mode,
    content: newFence.value,
    ...(verbose !== undefined ? { verbose } : {}),
    ...(stopOnError !== undefined ? { stopOnError } : {}),
  };
  return { kind: "ok", op };
}

interface FenceFailure {
  readonly ok: false;
  readonly error: ParseError;
  readonly recovery: "expected_open" | "via_fence" | "via_file" | "via_eof";
}

type FenceResult = { readonly ok: true; readonly value: string } | FenceFailure;

function parseFence(c: Ctx, kind: "OLD" | "NEW"): FenceResult {
  const openRe = kind === "OLD" ? RE_FENCE_OPEN_OLD : RE_FENCE_OPEN_NEW;
  const closeRe = kind === "OLD" ? RE_FENCE_CLOSE_OLD : RE_FENCE_CLOSE_NEW;

  while (!atEof(c) && isBlank(peek(c))) advance(c);

  if (atEof(c)) {
    return {
      ok: false,
      error: { line: lineNo(c), message: `expected <<<${kind} fence, got EOF` },
      recovery: "expected_open",
    };
  }

  const openLine = peek(c);
  const openM = openRe.exec(openLine);
  if (!openM || isIndented(openLine)) {
    return {
      ok: false,
      error: { line: lineNo(c), message: `expected <<<${kind} fence, got: ${truncate(openLine)}` },
      recovery: "expected_open",
    };
  }
  const suffix = openM[1] ?? "";
  const openLineNo = lineNo(c);
  advance(c);

  const collected: string[] = [];
  while (!atEof(c)) {
    const line = peek(c);
    const closeM = closeRe.exec(line);
    if (closeM && (closeM[1] ?? "") === suffix && !isIndented(line)) {
      advance(c);
      return { ok: true, value: collected.join("\n") };
    }
    if (!isIndented(line)) {
      if (RE_FENCE_OPEN_OLD.test(line) || RE_FENCE_OPEN_NEW.test(line)) {
        return {
          ok: false,
          error: {
            line: openLineNo,
            message: `<<<${kind}${suffix ? "#" + suffix : ""} not closed before next opening fence at line ${lineNo(c)}`,
          },
          recovery: "via_fence",
        };
      }
      if (RE_FILE.test(line)) {
        return {
          ok: false,
          error: {
            line: openLineNo,
            message: `<<<${kind}${suffix ? "#" + suffix : ""} not closed before next File: at line ${lineNo(c)}`,
          },
          recovery: "via_file",
        };
      }
    }
    collected.push(line);
    advance(c);
  }
  return {
    ok: false,
    error: {
      line: openLineNo,
      message: `<<<${kind}${suffix ? "#" + suffix : ""} not closed before EOF`,
    },
    recovery: "via_eof",
  };
}

function fenceFailureToActionResult(c: Ctx, f: FenceFailure, actionLineNo: number): ActionResult {
  if (f.recovery === "via_fence") {
    const decision = lookBackForAction(c, actionLineNo);
    if (decision === "new_action") {
      return { kind: "unparseable_op", error: f.error };
    }
    if (decision === "broken_action") {
      skipFence(c);
      while (!atEof(c)) {
        const line = peek(c);
        if (isBlank(line) || isIndented(line)) {
          advance(c);
          continue;
        }
        if (RE_FILE.test(line) || RE_ACTION.test(line)) break;
        if (RE_FENCE_OPEN_OLD.test(line) || RE_FENCE_OPEN_NEW.test(line)) {
          if (!skipFence(c)) break;
          continue;
        }
        advance(c);
      }
      return { kind: "unparseable_op", error: f.error };
    }
    return { kind: "unparseable_file", error: f.error };
  }
  if (f.recovery === "expected_open") {
    return { kind: "unparseable_op", error: f.error };
  }
  return { kind: "unparseable_file", error: f.error };
}

function lookBackForAction(c: Ctx, brokenActionLineNo: number): "new_action" | "broken_action" | "none" {
  const fenceIdx = c.cursor;
  const brokenIdx = brokenActionLineNo - 1;
  for (let i = fenceIdx - 1; i >= brokenIdx; i--) {
    const line = c.lines[i] ?? "";
    if (isIndented(line)) continue;
    if (RE_FILE.test(line)) return "none";
    const actionM = RE_ACTION.exec(line);
    if (actionM && ACTIONS.has(actionM[1]!)) {
      if (i === brokenIdx) return "broken_action";
      c.cursor = i;
      return "new_action";
    }
  }
  return "none";
}

function collectActionThenError(c: Ctx, error: ParseError): ActionResult {
  while (!atEof(c)) {
    const line = peek(c);
    if (!isIndented(line) && (RE_FILE.test(line) || RE_ACTION.test(line))) break;
    if (!isIndented(line) && (RE_FENCE_OPEN_OLD.test(line) || RE_FENCE_OPEN_NEW.test(line))) {
      const skipped = skipFence(c);
      if (!skipped) break;
      continue;
    }
    advance(c);
  }
  return { kind: "unparseable_op", error };
}

function skipFence(c: Ctx): boolean {
  const openLine = peek(c);
  const isOld = RE_FENCE_OPEN_OLD.test(openLine);
  const isNew = RE_FENCE_OPEN_NEW.test(openLine);
  if (!isOld && !isNew) return false;
  const openM = (isOld ? RE_FENCE_OPEN_OLD : RE_FENCE_OPEN_NEW).exec(openLine)!;
  const suffix = openM[1] ?? "";
  const closeRe = isOld ? RE_FENCE_CLOSE_OLD : RE_FENCE_CLOSE_NEW;
  advance(c);
  while (!atEof(c)) {
    const line = peek(c);
    const closeM = closeRe.exec(line);
    if (closeM && (closeM[1] ?? "") === suffix && !isIndented(line)) {
      advance(c);
      return true;
    }
    if (!isIndented(line) && (RE_FILE.test(line) || RE_ACTION.test(line))) {
      return false;
    }
    advance(c);
  }
  return false;
}

function skipToNextFile(c: Ctx): void {
  while (!atEof(c)) {
    const line = peek(c);
    if (!isIndented(line) && RE_FILE.test(line)) return;
    advance(c);
  }
}

function atEof(c: Ctx): boolean {
  return c.cursor >= c.lines.length;
}
function peek(c: Ctx): string {
  return c.lines[c.cursor] ?? "";
}
function advance(c: Ctx): void {
  c.cursor++;
}
function lineNo(c: Ctx): number {
  return c.cursor + 1;
}
function isBlank(line: string): boolean {
  return line.trim() === "";
}
function isIndented(line: string): boolean {
  return line.length > 0 && (line[0] === " " || line[0] === "\t");
}
function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
function parsePositiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}
function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 60) + "..." : s;
}
