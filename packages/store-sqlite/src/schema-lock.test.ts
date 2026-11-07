import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase } from './schema.js';

it('honors the busy timeout before initialization under another process exclusive lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-schema-lock-'));
  const path = join(root, 'runtime.sqlite');
  openDatabase(path, 150).close();
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       const mode = db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
       db.exec('BEGIN EXCLUSIVE');
       const release = () => { db.exec('ROLLBACK'); db.close(); process.disconnect(); };
       process.once('message', release);
       process.send({ locked: true, mode });`,
      path,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  const closed = once(holder, 'close');
  let stderr = '';
  holder.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [ready] = await once(holder, 'message', { signal: AbortSignal.timeout(5000) });
    expect(ready).toEqual({ locked: true, mode: 'delete' });
    const started = performance.now();
    let failure: unknown;
    try {
      openDatabase(path, 150).close();
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - started;
    expect(failure).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
    // The holder cannot release before this call returns. A generous lower bound
    // detects an immediate failure before timeout installation, without an upper
    // wall-clock bound or a timed release racing the contender.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    holder.send('release');
    const [exit, signal] = await closed;
    expect({ exit, signal }, stderr).toEqual({ exit: 0, signal: null });
    const reopened = openDatabase(path, 150);
    try {
      expect(reopened.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
      expect(reopened.prepare('PRAGMA synchronous').get()?.['synchronous']).toBe(2);
      expect(reopened.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
    } finally {
      reopened.close();
    }
  } finally {
    if (holder.exitCode === null) holder.kill('SIGKILL');
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
