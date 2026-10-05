import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { expect } from "./helpers/expect.js";
import { handleBatchEdit } from "../src/tools/edit.js";
import { handleBatchRead } from "../src/tools/read.js";
import { isAccessible, isPathAllowed, resolveExcludePaths } from "../src/lib/fs.js";

let allowedDir: string;
let outsideDir: string;

before(async () => {
  allowedDir = await realpath(await mkdtemp(join(tmpdir(), "btf-auth-in-")));
  outsideDir = await realpath(await mkdtemp(join(tmpdir(), "btf-auth-out-")));
});

after(async () => {
  await rm(allowedDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function overwrite(p: string, excludedPaths: readonly string[] = []) {
  return handleBatchEdit(
    { files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "owned\n" }] }] },
    [allowedDir],
    false,
    excludedPaths,
  );
}

describe("auth — read", () => {
  it("rejects reads of files outside allowed directories", async () => {
    const p = join(outsideDir, "secret.txt");
    await writeFile(p, "secret\n");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "verbatim" }] }, [allowedDir]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(out.results[0]!.content).toBe("");
  });

  it("rejects everything when allowedDirectories is empty", async () => {
    const p = join(allowedDir, "anything.txt");
    await writeFile(p, "x\n");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "verbatim" }] }, []);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("rejects read of non-existent file outside allowed directories", async () => {
    const p = join(outsideDir, "ghost.txt");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "compact" }] }, [allowedDir]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("returns not_found for non-existent file inside allowed directories", async () => {
    const p = join(allowedDir, "ghost.txt");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "compact" }] }, [allowedDir]);
    expect(out.results[0]!.error?.reason).toBe("not_found");
  });
});

describe("auth — edit", () => {
  it("rejects write at a path outside allowed directories and does not write to disk", async () => {
    const p = join(outsideDir, "pwn.txt");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "owned\n" }] }] },
      [allowedDir],
      false,
    );
    const fr = out.results[0]!;
    expect(fr.status).toBe("error");
    expect(fr.error?.reason).toBe("not_authorized");
    expect(await exists(p)).toBe(false);
  });

  it("rejects write in a non-existent nested path outside allowed directories", async () => {
    const p = join(outsideDir, "missing", "nested", "pwn.txt");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "owned\n" }] }] },
      [allowedDir],
      false,
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await exists(p)).toBe(false);
  });

  it("allows write in a non-existent nested path inside allowed directories", async () => {
    const p = join(allowedDir, "deep", "nested", "ok.txt");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "fine\n" }] }] },
      [allowedDir],
      false,
    );
    expect(out.results[0]!.status).toBe("ok");
    expect(await exists(p)).toBe(true);
  });

  it("rejects edit when allowedDirectories is empty", async () => {
    const p = join(allowedDir, "any.txt");
    await writeFile(p, "x\n");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "append", content: "y\n" }] }] },
      [],
      false,
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });
});

describe("auth — excluded paths", () => {
  it("blocks read of excluded file inside allowed dir", async () => {
    const p = join(allowedDir, "secret.env");
    await writeFile(p, "SECRET=123\n");
    const out = await handleBatchRead(
      { requests: [{ path: p, mode: "compact" }] },
      [allowedDir],
      [p],
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(out.results[0]!.content).toBe("");
  });

  it("blocks read of file inside excluded subdirectory", async () => {
    const dir = join(allowedDir, "secrets");
    await mkdir(dir, { recursive: true });
    const p = join(dir, "key.txt");
    await writeFile(p, "key\n");
    const out = await handleBatchRead(
      { requests: [{ path: p, mode: "compact" }] },
      [allowedDir],
      [dir],
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("does not affect reads of non-excluded files when exclusions are active", async () => {
    const p = join(allowedDir, "normal.txt");
    await writeFile(p, "fine\n");
    const out = await handleBatchRead(
      { requests: [{ path: p, mode: "compact" }] },
      [allowedDir],
      [join(allowedDir, "other-dir")],
    );
    expect(out.results[0]!.error).toBeUndefined();
  });

  it("blocks edit of excluded file inside allowed dir", async () => {
    const p = join(allowedDir, "creds.env");
    await writeFile(p, "KEY=val\n");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "append", content: "x" }] }] },
      [allowedDir],
      false,
      [p],
    );
    expect(out.results[0]!.status).toBe("error");
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("does not affect edits of non-excluded files when exclusions are active", async () => {
    const p = join(allowedDir, "editable.txt");
    await writeFile(p, "old\n");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "new\n" }] }] },
      [allowedDir],
      false,
      [join(allowedDir, "other-dir")],
    );
    expect(out.results[0]!.status).toBe("ok");
  });
});

describe("isAccessible — predicate", () => {
  it("allows a path inside an allowed dir when not excluded", () => {
    expect(isAccessible(join(allowedDir, "a.txt"), [allowedDir], [], [])).toBe(true);
  });

  it("denies a path outside all allowed dirs", () => {
    expect(isAccessible(join(outsideDir, "a.txt"), [allowedDir], [], [])).toBe(false);
  });

  it("denies an excluded path even when inside an allowed dir", () => {
    const p = join(allowedDir, "secret.env");
    expect(isAccessible(p, [allowedDir], [p], [])).toBe(false);
  });

  it("does not let an allow/include entry pierce an exclude", () => {
    const sub = join(allowedDir, "secrets");
    const p = join(sub, "k.txt");
    expect(isAccessible(p, [allowedDir, sub], [sub], [])).toBe(false);
  });

  it("lets an exact-file approval pierce an exclude", () => {
    const p = join(allowedDir, "secret.env");
    expect(isAccessible(p, [allowedDir], [p], [p])).toBe(true);
  });

  it("lets a folder approval pierce an exclude for all descendants", () => {
    const dir = join(allowedDir, "secrets");
    const p = join(dir, "deep", "k.txt");
    expect(isAccessible(p, [allowedDir], [dir], [dir])).toBe(true);
  });
});

describe("auth — exclude overrides", () => {
  it("allows read of an excluded file when it is approved", async () => {
    const p = join(allowedDir, "approved.env");
    await writeFile(p, "SECRET=1\n");
    const out = await handleBatchRead(
      { requests: [{ path: p, mode: "compact" }] },
      [allowedDir],
      [p],
      [p],
    );
    expect(out.results[0]!.error).toBeUndefined();
  });

  it("lifts a folder exclude for a file inside when the folder is approved", async () => {
    const dir = join(allowedDir, "approved-secrets");
    await mkdir(dir, { recursive: true });
    const p = join(dir, "key.txt");
    await writeFile(p, "key\n");
    const out = await handleBatchRead(
      { requests: [{ path: p, mode: "compact" }] },
      [allowedDir],
      [dir],
      [dir],
    );
    expect(out.results[0]!.error).toBeUndefined();
  });

  it("keeps blocking a different excluded file when only one is approved", async () => {
    const approved = join(allowedDir, "ok.env");
    const blocked = join(allowedDir, "no.env");
    await writeFile(approved, "A=1\n");
    await writeFile(blocked, "B=2\n");
    const out = await handleBatchRead(
      { requests: [{ path: blocked, mode: "compact" }] },
      [allowedDir],
      [approved, blocked],
      [approved],
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("allows edit of an excluded file when it is approved", async () => {
    const p = join(allowedDir, "approved-creds.env");
    await writeFile(p, "KEY=val\n");
    const out = await handleBatchEdit(
      { files: [{ path: p, ops: [{ type: "write", mode: "append", content: "x" }] }] },
      [allowedDir],
      false,
      [p],
      [p],
    );
    expect(out.results[0]!.status).toBe("ok");
  });
});

describe("resolveExcludePaths", () => {
  it("resolves an absolute exclude to its canonical path", async () => {
    const p = join(allowedDir, "abs.env");
    await writeFile(p, "1\n");
    const out = await resolveExcludePaths([p], []);
    expect(out.includes(await realpath(p))).toBe(true);
  });

  it("anchors a relative exclude to every provided directory", async () => {
    await writeFile(join(allowedDir, "rel.env"), "1\n");
    await writeFile(join(outsideDir, "rel.env"), "2\n");
    const out = await resolveExcludePaths(["rel.env"], [allowedDir, outsideDir]);
    expect(out.includes(await realpath(join(allowedDir, "rel.env")))).toBe(true);
    expect(out.includes(await realpath(join(outsideDir, "rel.env")))).toBe(true);
  });

  it("keeps a not-yet-existing relative exclude as a literal anchored path", async () => {
    const out = await resolveExcludePaths(["ghost.env"], [allowedDir]);
    expect(out.some(p => p.endsWith("ghost.env"))).toBe(true);
  });
});

describe("auth — dangling links", () => {
  it("rejects write through a dangling file symlink and does not create its target", async (t) => {
    const target = join(outsideDir, "escaped.txt");
    const link = join(allowedDir, "dangle.txt");
    try {
      await symlink(target, link, "file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip("file symlinks need admin or developer mode");
      throw err;
    }
    const out = await overwrite(link);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await exists(target)).toBe(false);
  });

  it("rejects write below a dangling junction and does not create its target", async () => {
    const target = join(outsideDir, "missing-dir");
    const link = join(allowedDir, "dangle-junction");
    await symlink(target, link, "junction");
    const out = await overwrite(join(link, "escaped.txt"));
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await exists(target)).toBe(false);
  });

  it("rejects read below a dangling junction", async () => {
    const link = join(allowedDir, "dangle-junction-read");
    await symlink(join(outsideDir, "missing-read-dir"), link, "junction");
    const out = await handleBatchRead({ requests: [{ path: join(link, "x.txt"), mode: "compact" }] }, [allowedDir]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });
});

describe("auth — excludes on not-yet-existing files", () => {
  it("blocks creating a file in an excluded dir through a junction", async () => {
    const secrets = join(allowedDir, "junction-secrets");
    await mkdir(secrets, { recursive: true });
    const link = join(allowedDir, "jl");
    await symlink(secrets, link, "junction");
    const out = await overwrite(join(link, "new.txt"), [secrets]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await exists(join(secrets, "new.txt"))).toBe(false);
  });

  it("blocks reading a missing file in an excluded dir through a junction", async () => {
    const secrets = join(allowedDir, "junction-secrets-read");
    await mkdir(secrets, { recursive: true });
    const link = join(allowedDir, "jl-read");
    await symlink(secrets, link, "junction");
    const out = await handleBatchRead(
      { requests: [{ path: join(link, "ghost.txt"), mode: "compact" }] },
      [allowedDir],
      [secrets],
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("blocks creating a file in an excluded dir via its 8.3 short name", async (t) => {
    if (process.platform !== "win32") return t.skip("8.3 short names are Windows-only");
    const secrets = join(allowedDir, "secretstuff");
    await mkdir(secrets, { recursive: true });
    const shortName = execFileSync("cmd", ["/d", "/c", "for %I in (secretstuff) do @echo %~snxI"], {
      cwd: allowedDir,
      encoding: "utf8",
    }).trim();
    if (shortName.toLowerCase() === "secretstuff") return t.skip("8.3 short names disabled on this volume");
    const out = await overwrite(join(allowedDir, shortName, "new.txt"), [secrets]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await exists(join(secrets, "new.txt"))).toBe(false);
  });
});

describe("auth — '..'-prefixed names", () => {
  it("treats a '..'-prefixed child as inside the directory", () => {
    expect(isPathAllowed(join(allowedDir, "..ok.txt"), [allowedDir])).toBe(true);
  });

  it("treats the parent directory and its other children as outside", () => {
    expect(isPathAllowed(join(allowedDir, ".."), [allowedDir])).toBe(false);
    expect(isPathAllowed(join(allowedDir, "..", "sibling.txt"), [allowedDir])).toBe(false);
  });

  it("allows read of a '..'-prefixed file inside an allowed dir", async () => {
    const p = join(allowedDir, "..ok.txt");
    await writeFile(p, "ok\n");
    const out = await handleBatchRead({ requests: [{ path: p, mode: "compact" }] }, [allowedDir]);
    expect(out.results[0]!.error).toBeUndefined();
  });

  it("blocks read of a '..'-prefixed file inside an excluded dir", async () => {
    const secrets = join(allowedDir, "dot-secrets");
    await mkdir(secrets, { recursive: true });
    const p = join(secrets, "..env");
    await writeFile(p, "SECRET=1\n");
    const out = await handleBatchRead({ requests: [{ path: p, mode: "compact" }] }, [allowedDir], [secrets]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(out.results[0]!.content).toBe("");
  });

  it("blocks edit below a '..'-prefixed subdir of an excluded dir", async () => {
    const secrets = join(allowedDir, "dot-secrets-edit");
    const p = join(secrets, "..x", "key.txt");
    await mkdir(join(secrets, "..x"), { recursive: true });
    await writeFile(p, "key\n");
    const out = await overwrite(p, [secrets]);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });
});
