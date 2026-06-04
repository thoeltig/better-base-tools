import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, releaseLock, acquireSubmitLock } from './lock.js';

const LOCK_FILE = 'summaries.lock';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
});

afterEach(() => {
  releaseLock();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('creates lock file and returns true when directory is free', () => {
    const result = acquireLock(tmpDir);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, LOCK_FILE))).toBe(true);
  });

  it('lock file contains current pid and a valid ISO timestamp', () => {
    acquireLock(tmpDir);
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, LOCK_FILE), 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(() => new Date(content.startedAt)).not.toThrow();
    expect(new Date(content.startedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('returns false when lock is held by the current live process', () => {
    // Write a fresh lock as the current process — looks live to isLockStale
    const lockPath = path.join(tmpDir, LOCK_FILE);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(acquireLock(tmpDir)).toBe(false);
  });

  it('takes over a lock held by a dead process (non-existent pid)', () => {
    const lockPath = path.join(tmpDir, LOCK_FILE);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() }));
    expect(acquireLock(tmpDir)).toBe(true);
  });

  it('takes over a lock with a corrupt file', () => {
    fs.writeFileSync(path.join(tmpDir, LOCK_FILE), 'not valid json{{{');
    expect(acquireLock(tmpDir)).toBe(true);
  });

  it('takes over a lock that has exceeded the max age (1 hour)', () => {
    const staleStart = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(tmpDir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: staleStart }));
    expect(acquireLock(tmpDir)).toBe(true);
  });
});

describe('releaseLock', () => {
  it('removes the lock file after acquire', () => {
    acquireLock(tmpDir);
    const lockPath = path.join(tmpDir, LOCK_FILE);
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseLock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not throw when called with no active lock', () => {
    expect(() => releaseLock()).not.toThrow();
  });

  it('allows re-acquisition after release', () => {
    acquireLock(tmpDir);
    releaseLock();
    expect(acquireLock(tmpDir)).toBe(true);
  });
});

describe('acquireSubmitLock', () => {
  it('returns true when the directory is free', async () => {
    const result = await acquireSubmitLock(tmpDir, 1000, 50);
    expect(result).toBe(true);
  });

  it('returns false when lock is held and timeout expires', async () => {
    // Write a live lock so acquireLock always returns false
    const lockPath = path.join(tmpDir, LOCK_FILE);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const result = await acquireSubmitLock(tmpDir, 150, 50);
    expect(result).toBe(false);
    fs.unlinkSync(lockPath);
  }, 2000);

  it('returns true if lock is released mid-wait', async () => {
    // Hold the lock for 100ms then release it; acquireSubmitLock should succeed
    const lockPath = path.join(tmpDir, LOCK_FILE);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    setTimeout(() => fs.unlinkSync(lockPath), 100);
    const result = await acquireSubmitLock(tmpDir, 1000, 60);
    expect(result).toBe(true);
  }, 2000);
});
