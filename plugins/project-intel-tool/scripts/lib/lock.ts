import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOCK_FILE = 'summaries.lock';
const LOCK_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

let activeLockPath: string | null = null;
function isLockStale(lock: { pid: number; startedAt: string }): boolean {
  try {
    process.kill(lock.pid, 0);
    return Date.now() - new Date(lock.startedAt).getTime() > LOCK_MAX_AGE_MS;
  } catch (err: any) {
    return err.code !== 'EPERM'; // ESRCH = dead; EPERM = alive, no permission
  }
}

export function acquireLock(knowledgeDir: string): boolean {
  const lockPath = join(knowledgeDir, LOCK_FILE);
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (!isLockStale(lock)) return false;
    } catch { /* corrupt lock — treat as stale */ }
  }
  try {
    const tmpPath = lockPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    renameSync(tmpPath, lockPath);
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

export async function acquireSubmitLock(knowledgeDir: string, timeoutMs = 30_000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (acquireLock(knowledgeDir)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}