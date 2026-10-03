import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

const LOCK_FILE = 'summaries.lock';
const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
// An unparsable lock may be mid-write by its creator; only an older one counts as abandoned.
const CORRUPT_LOCK_GRACE_MS = 5_000;

let activeLockPath: string | null = null;
function isLockStale(lock: { pid: number; startedAt: string }): boolean {
  try {
    process.kill(lock.pid, 0);
    return Date.now() - new Date(lock.startedAt).getTime() > LOCK_MAX_AGE_MS;
  } catch (err: any) {
    return err.code !== 'EPERM'; // ESRCH = dead; EPERM = alive, no permission
  }
}

function isLockFileStale(lockPath: string): boolean {
  try {
    return isLockStale(JSON.parse(readFileSync(lockPath, 'utf-8')));
  } catch {
    try { return Date.now() - statSync(lockPath).mtimeMs > CORRUPT_LOCK_GRACE_MS; }
    catch { return true; }
  }
}

export function acquireLock(knowledgeDir: string): boolean {
  const lockPath = join(knowledgeDir, LOCK_FILE);
  if (existsSync(lockPath)) {
    if (!isLockFileStale(lockPath)) return false;
    try { unlinkSync(lockPath); } catch { /* already removed by another process */ }
  }
  try {
    // 'wx' fails when another process created the lock since the check above
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
    activeLockPath = lockPath;
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  if (!activeLockPath) return;
  try { unlinkSync(activeLockPath); } catch { /* ignore */ }
  activeLockPath = null;
}

export async function acquireLockWithWait(knowledgeDir: string, timeoutMs = 10_000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (acquireLock(knowledgeDir)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}
