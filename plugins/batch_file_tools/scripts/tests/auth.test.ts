import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { expect } from "./helpers/expect.js";
import { handleBatchEdit } from "../src/tools/edit.js";
import { handleBatchRead } from "../src/tools/read.js";

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
  const out = await handleBatchRead({ requests: [{ path: p, mode: "verbatim_numbered" }] }, [allowedDir], true);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(out.results[0]!.content).toBe("");
  });

  it("rejects everything when allowedDirectories is empty", async () => {
    const p = join(allowedDir, "anything.txt");
    await writeFile(p, "x\n");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "verbatim_numbered" }] }, [], true);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("rejects read of non-existent file outside allowed directories", async () => {
    const p = join(outsideDir, "ghost.txt");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "compact" }] }, [allowedDir], true);
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });

  it("returns not_found for non-existent file inside allowed directories", async () => {
    const p = join(allowedDir, "ghost.txt");
  const out = await handleBatchRead({ requests: [{ path: p, mode: "compact" }] }, [allowedDir], true);
    expect(out.results[0]!.error?.reason).toBe("not_found");
  });
});

describe("auth — edit", () => {
  it("rejects write at a path outside allowed directories and does not write to disk", async () => {
    const p = join(outsideDir, "pwn.txt");
    const out = await handleBatchEdit(
      {
        dryRun: false,
        files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "owned\n" }] }],
      },
      [allowedDir],
    );
    const fr = out.results[0]!;
    expect(fr.status).toBe("error");
    expect(fr.error?.reason).toBe("not_authorized");
    expect(await exists(p)).toBe(false);
  });

  it("rejects write in a non-existent nested path outside allowed directories", async () => {
    const p = join(outsideDir, "missing", "nested", "pwn.txt");
    const out = await handleBatchEdit(
      {
        dryRun: false,
        files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "owned\n" }] }],
      },
      [allowedDir],
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
    expect(await exists(p)).toBe(false);
  });

  it("allows write in a non-existent nested path inside allowed directories", async () => {
    const p = join(allowedDir, "deep", "nested", "ok.txt");
    const out = await handleBatchEdit(
      {
        dryRun: false,
        files: [{ path: p, ops: [{ type: "write", mode: "overwrite", content: "fine\n" }] }],
      },
      [allowedDir],
    );
    expect(out.results[0]!.status).toBe("ok");
    expect(await exists(p)).toBe(true);
  });

  it("rejects edit when allowedDirectories is empty", async () => {
    const p = join(allowedDir, "any.txt");
    await writeFile(p, "x\n");
    const out = await handleBatchEdit(
      {
        dryRun: false,
        files: [{ path: p, ops: [{ type: "write", mode: "append", content: "y\n" }] }],
      },
      [],
    );
    expect(out.results[0]!.error?.reason).toBe("not_authorized");
  });
});
