import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { Reason } from "../types.js";
import { fileURLToPath } from "node:url";
import type { Root } from "@modelcontextprotocol/sdk/types.js";
import { writeLogLine } from "./log.js";

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

export async function getAllowedDirectoriesFromArgs(
  directories: readonly string[],
): Promise<string[]> {
  const resolved = await Promise.all(
    directories.map(async (dir) => {
      if (!dir) return null;
      try {
        const expanded = expandHome(dir);
        if (!isAbsolute(expanded)) return null;
        const real = await realpath(resolve(expanded));
        return real;
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((p): p is string => p !== null);
}

export async function getValidRootDirectories(
  requestedRoots: readonly Root[],
): Promise<string[]> {
  const validated: string[] = [];
  for (const root of requestedRoots) {
    const resolved = await parseRootUri(root.uri);
    if (!resolved) {
      writeLogLine(`Skipping invalid root: ${root.uri}`);
      continue;
    }
    try {
      const stats = await stat(resolved);
      if (stats.isDirectory()) {
        validated.push(resolved);
      } else {
        writeLogLine(`Skipping non-directory root: ${resolved}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLogLine(`Skipping unreadable root ${resolved}: ${message}`);
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
  const expanded = expandHome(inputPath);
  if (!isAbsolute(expanded)) {
    return { ok: false, reason: "not_absolute", message: `Path must be absolute: ${inputPath}` };
  }
  if (allowedDirectories.length === 0) {
    return {
      ok: false,
      reason: "not_authorized",
      message: `No allowed directories configured; refusing access to ${inputPath}`,
    };
  }

  try {
    const absolute = resolve(expanded);
    const resolvedPath = options.allowMissing
      ? await realpathOfNearestExisting(absolute)
      : await realpath(absolute);

    if (!isPathAllowed(resolvedPath, allowedDirectories)) {
      return { ok: false, reason: "not_authorized", message: `Access denied: ${inputPath}` };
    }
    return { ok: true, resolvedPath };
  } catch (err: unknown) {
    return mapFsError(err, inputPath);
  }
}

function isPathAllowed(realPath: string, allowedDirectories: readonly string[]): boolean {
  return allowedDirectories.some((dir) => {
    const rel = relative(dir, realPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

async function realpathOfNearestExisting(absolute: string): Promise<string> {
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
