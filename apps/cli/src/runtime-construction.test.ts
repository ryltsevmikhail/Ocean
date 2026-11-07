import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import type * as Sqlite from '@runnets/store-sqlite';
import { createRuntime } from './runtime.js';

const observed = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('@runnets/store-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof Sqlite>();
  return {
    ...original,
    openSqliteStore: (...args: Parameters<typeof original.openSqliteStore>) => {
      const store = original.openSqliteStore(...args);
      const close = store.close.bind(store);
      store.close = () => {
        observed.close();
        close();
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
