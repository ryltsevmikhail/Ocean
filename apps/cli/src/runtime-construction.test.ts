import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import type * as Sqlite from '@runnets/store-sqlite';
import { createRuntime } from './runtime.js';
import { DirectChatService } from '@runnets/application';

const observed = vi.hoisted(() => ({
  close: vi.fn(),
  release: vi.fn(),
  closeError: false,
  releaseError: false,
}));
vi.mock('@runnets/store-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof Sqlite>();
  return {
    ...original,
    ownSqliteRuntime: (...args: Parameters<typeof original.ownSqliteRuntime>) => {
      const release = original.ownSqliteRuntime(...args);
      return () => {
        observed.release();
        release();
        if (observed.releaseError) throw Error('release failure');
      };
    },
    openSqliteStore: (...args: Parameters<typeof original.openSqliteStore>) => {
      const store = original.openSqliteStore(...args);
      const close = store.close.bind(store);
      store.close = () => {
        observed.close();
        close();
        if (observed.closeError) throw Error('close failure');
      };
      return store;
    },
  };
});

it('closes the opened store on invalid origin and releases runtime ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-construction-'));
  const path = join(root, 'runtime.sqlite');
  try {
    const seed = openSqliteStore({ path });
    seed.close();
    const db = new DatabaseSync(path);
    db.exec("INSERT INTO ocean_restore_origin VALUES(1,'{}')");
    db.close();
    observed.close.mockClear();
    expect(() => createRuntime({ dbPath: path })).toThrow('invalid_restore_origin');
    expect(observed.close).toHaveBeenCalledTimes(1);
    const repair = new DatabaseSync(path);
    repair.exec('DELETE FROM ocean_restore_origin');
    repair.close();
    const runtime = createRuntime({ dbPath: path });
    await runtime.ready;
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not start recovery when late construction fails and permits later ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-late-'));
  const path = join(root, 'runtime.sqlite');
  const failure = Error('late option failure');
  const recover = vi
    .spyOn(DirectChatService.prototype, 'recover')
    .mockReturnValue(new Promise(() => {}));
  try {
    observed.close.mockClear();
    expect(() =>
      createRuntime({
        dbPath: path,
        get codingWorktreeDirectory(): string {
          throw failure;
        },
      }),
    ).toThrow(failure);
    expect(recover).not.toHaveBeenCalled();
    expect(observed.close).toHaveBeenCalledTimes(1);
    recover.mockRestore();
    const runtime = createRuntime({ dbPath: path });
    await runtime.ready;
    runtime.close();
  } finally {
    recover.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves the construction error when close and release both fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-errors-'));
  const failure = Error('primary failure');
  const recover = vi
    .spyOn(DirectChatService.prototype, 'recover')
    .mockReturnValue(new Promise(() => {}));
  try {
    observed.release.mockClear();
    observed.close.mockClear();
    observed.closeError = true;
    observed.releaseError = true;
    let thrown: unknown;
    try {
      createRuntime({
        dbPath: join(root, 'runtime.sqlite'),
        get codingWorktreeDirectory(): string {
          throw failure;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(observed.close).toHaveBeenCalledTimes(1);
    expect(observed.release).toHaveBeenCalledTimes(1);
  } finally {
    observed.closeError = false;
    observed.releaseError = false;
    recover.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
