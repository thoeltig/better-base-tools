import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { Reason } from "../types.js";
import { fileURLToPath } from "node:url";
import type { Root, LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

export interface ReadFileResult {
  readonly ok: true;
  readonly content: string;
  readonly resolvedPath: string;
}

export interface ReadFileError {
  readonly ok: false;
  readonly reason: Reason;
  readonly message: string;
}

export async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

export async function readFileUtf8(
  inputPath: string,
  allowedDirectories: readonly string[],
): Promise<ReadFileResult | ReadFileError> {
  const guard = await guardPath(inputPath, allowedDirectories, { allowMissing: false });
  if (!guard.ok) return guard;

  try {
    const content = await readFile(guard.resolvedPath, { encoding: "utf8" });
    return { ok: true, content, resolvedPath: guard.resolvedPath };
  } catch (err: unknown) {
    return mapFsError(err, inputPath);
  }
}

export async function resolveForWrite(
  inputPath: string,
  allowedDirectories: readonly string[],
): Promise<{ ok: true; resolvedPath: string } | ReadFileError> {
  const guard = await guardPath(inputPath, allowedDirectories, { allowMissing: true });
  if (!guard.ok) return guard;
  return { ok: true, resolvedPath: guard.resolvedPath };
}

export async function resolvePaths(
  paths: readonly string[],
): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map(async (p) => {
      if (!p) return null;
      try {
        // Anchor to the nearest existing parent so relative paths, symlinks and
        // not-yet-created files/subfolders resolve to a canonical absolute path.
        return await realpathOfNearestExisting(resolve(expandHome(p)));
      } catch {
        return null;
      }
    }),
  );
  return [...new Set(resolved.filter((p): p is string => p !== null))];
}

export async function getValidRootDirectories(
  requestedRoots: readonly Root[],
  log: (level: LoggingLevel, data: string, logger?: string) => void,
): Promise<string[]> {
  const validated: string[] = [];
  for (const root of requestedRoots) {
    const resolved = await parseRootUri(root.uri);
    if (!resolved) {
      log("warning", `Skipping invalid root: ${root.uri}`, "roots");
      continue;
    }
    try {
      const stats = await stat(resolved);
      if (stats.isDirectory()) {
        validated.push(resolved);
      } else {
        log("warning", `Skipping non-directory root: ${resolved}`, "roots");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("warning", `Skipping unreadable root ${resolved}: ${message}`, "roots");
    }
  }
  return validated;
}

function expandHome(filepath: string): string {
  if (filepath === "~" || filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

async function parseRootUri(rootUri: string): Promise<string | null> {
  try {
    const raw = rootUri.startsWith("file://") ? fileURLToPath(rootUri) : rootUri;
    return await realpath(resolve(expandHome(raw)));
  } catch {
    return null;
  }
}

interface GuardOptions {
  readonly allowMissing: boolean;
}

type GuardResult =
  | { ok: true; resolvedPath: string }
  | ReadFileError;

async function guardPath(
  inputPath: string,
  allowedDirectories: readonly string[],
  options: GuardOptions,
): Promise<GuardResult> {
  const expanded = resolve(expandHome(inputPath));
  if (allowedDirectories.length === 0) {
    return {
      ok: false,
      reason: "not_authorized",
      message: `No allowed directories configured; refusing access to ${inputPath}`,
    };
  }

  try {
    const absolute = resolve(expanded);
    const authPath = await realpathOfNearestExisting(absolute);
    if (!isPathAllowed(authPath, allowedDirectories)) {
      return { ok: false, reason: "not_authorized", message: `Access denied: ${inputPath}` };
    }
    const resolvedPath = options.allowMissing ? authPath : await realpath(absolute);
    return { ok: true, resolvedPath };
  } catch (err: unknown) {
    return mapFsError(err, inputPath);
  }
}

export function isPathAllowed(realPath: string, allowedDirectories: readonly string[]): boolean {
  return allowedDirectories.some((dir) => {
    const rel = relative(dir, realPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export function isAccessible(
  realPath: string,
  allowedDirectories: readonly string[],
  excludedPaths: readonly string[] = [],
  approvedPaths: readonly string[] = [],
): boolean {
  // Denied paths are reachable only via an explicit elicitation allow (an exact
  // file or a covering folder); configured allow/include paths never pierce an
  // exclude. Non-denied paths use the standard allow-list check.
  if (excludedPaths.length > 0 && isPathAllowed(realPath, excludedPaths)) {
    return isPathAllowed(realPath, approvedPaths);
  }
  return isPathAllowed(realPath, allowedDirectories);
}

export async function realpathOfNearestExisting(absolute: string): Promise<string> {
  let current = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      const real = await realpath(current);
      return missing.length === 0 ? real : resolve(real, ...missing);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function mapFsError(err: unknown, inputPath: string): ReadFileError {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "ENOENT") {
    return { ok: false, reason: "not_found", message: `File not found: ${inputPath}` };
  }
  if (e.code === "EISDIR") {
    return { ok: false, reason: "is_directory", message: `Path is a directory: ${inputPath}` };
  }
  if (e.code === "EACCES" || e.code === "EPERM") {
    return { ok: false, reason: "not_authorized", message: `Access denied: ${inputPath}` };
  }
  return { ok: false, reason: "io_error", message: e.message ?? String(err) };
}
