import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readFileUtf8 } from "./fs.js";
import { joinLines, splitLines } from "./lines.js";

export interface EditBuffer {
  existed: boolean;
  exists: boolean;
  lines: string[];
  endings: string[];
  defaultEnding: "\n" | "\r\n";
}

export async function loadBuffer(path: string): Promise<EditBuffer> {
  const file = await readFileUtf8(path);
  if (!file.ok) {
    if (file.reason === "not_found") {
      return {
        existed: false,
        exists: false,
        lines: [],
        endings: [],
        defaultEnding: "\n",
      };
    }
    throw new BufferLoadError(file.reason, file.message);
  }
  const split = splitLines(file.content);
  return {
    existed: true,
    exists: true,
    lines: [...split.lines],
    endings: [...split.endings],
    defaultEnding: detectDominantEnding(split.endings),
  };
}

export async function writeBuffer(path: string, buf: EditBuffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, joinLines(buf.lines, buf.endings), { encoding: "utf8" });
}

function detectDominantEnding(endings: readonly string[]): "\n" | "\r\n" {
  let crlf = 0;
  let lf = 0;
  for (const e of endings) {
    if (e === "\r\n") crlf++;
    else if (e === "\n") lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

export class BufferLoadError extends Error {
  constructor(
    public readonly reason: "is_directory" | "io_error" | "not_absolute",
    message: string,
  ) {
    super(message);
    this.name = "BufferLoadError";
  }
}
