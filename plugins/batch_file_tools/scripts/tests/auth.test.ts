import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { expect } from "./helpers/expect.js";
import { handleBatchEdit } from "../src/tools/edit.js";
import { handleBatchRead } from "../src/tools/read.js";
import { isAccessible, resolveExcludePaths } from "../src/lib/fs.js";

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
