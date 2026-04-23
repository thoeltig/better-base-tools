import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FileErrorReason } from "../types.js";

export interface ReadFileResult {
  readonly ok: true;
  readonly content: string;
}

export interface ReadFileError {
  readonly ok: false;
  readonly reason: FileErrorReason;
  readonly message: string;
}

export async function readFileUtf8(
  path: string,
): Promise<ReadFileResult | ReadFileError> {
  if (!isAbsolute(path)) {
    return {
      ok: false,
      reason: "not_absolute",
      message: `Path must be absolute: ${path}`,
    };
  }
  try {
    const content = await readFile(path, { encoding: "utf8" });
    return { ok: true, content };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { ok: false, reason: "not_found", message: `File not found: ${path}` };
    }
    if (e.code === "EISDIR") {
      return {
        ok: false,
        reason: "is_directory",
        message: `Path is a directory: ${path}`,
      };
    }
    return {
      ok: false,
      reason: "io_error",
      message: e.message ?? String(err),
    };
  }
}
