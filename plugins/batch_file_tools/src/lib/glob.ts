import { glob, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { resolve } from "node:path";

export function looksLikeGlob(p: string): boolean {
  return /[*?]/.test(p);
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function needsExpansion(p: string): Promise<boolean> {
  if (looksLikeGlob(p)) return true;
  return isDirectory(p);
}

/**
 * Expand a glob pattern or directory into a sorted list of absolute, real
 * (symlink-resolved) file paths. A bare directory expands to its immediate
 * children only (single level); use an explicit `**` glob for recursive walks.
 * Directories matched by the pattern are filtered out — only regular files are returned.
 */
export async function expandToFiles(p: string): Promise<string[]> {
  const pattern = (await isDirectory(p))
    ? `${p.replace(/\\/g, "/")}/*`
    : p.replace(/\\/g, "/");

  const out = new Set<string>();
  const iter = glob(pattern, { withFileTypes: true }) as AsyncIterable<Dirent>;
  for await (const entry of iter) {
    if (!entry.isFile()) continue;
    const full = resolve(entry.parentPath, entry.name);
    try {
      out.add(await realpath(full));
    } catch {
      // skip dangling/broken symlinks
    }
  }
  return [...out].sort();
}
