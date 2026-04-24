import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveForWrite } from "./fs.js";
import { joinLines, LineEnding, splitLines } from "./lines.js";
import { FileErrorReason } from "../types.js";

export interface EditBuffer {
  existed: boolean;
  exists: boolean;
  lines: string[];
  endings: string[];
  defaultEnding: LineEnding;
  resolvedPath: string;
}

export async function loadBuffer(
  path: string,
  allowedDirectories: readonly string[],
): Promise<EditBuffer> {
  const guard = await resolveForWrite(path, allowedDirectories);
  if (!guard.ok) {
    throw new BufferLoadError(guard.reason, guard.message);
  }

  try {
    const content = await readFile(guard.resolvedPath, { encoding: "utf8" });
    const split = splitLines(content);
    return {
      existed: true,
      exists: true,
      lines: [...split.lines],
      endings: [...split.endings],
      defaultEnding: split.dominantEnding,
      resolvedPath: guard.resolvedPath,
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        existed: false,
        exists: false,
        lines: [],
        endings: [],
        defaultEnding: "\n",
        resolvedPath: guard.resolvedPath,
      };
    }
    if (e.code === "EISDIR") {
      throw new BufferLoadError("is_directory", `Path is a directory: ${path}`);
    }
    throw new BufferLoadError("io_error", e.message ?? String(err));
  }
}

export async function writeBuffer(buf: EditBuffer): Promise<void> {
  await mkdir(dirname(buf.resolvedPath), { recursive: true });
  await writeFile(buf.resolvedPath, joinLines(buf.lines, buf.endings), { encoding: "utf8" });
}

export class BufferLoadError extends Error {
  constructor(
    public readonly reason: FileErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "BufferLoadError";
  }
}
