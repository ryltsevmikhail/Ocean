import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '@runnets/store-sqlite';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { managedLifetimeFixture } from '../../../../packages/store-sqlite/test-fixtures/managed-lifetime.ts';
import type { ToolEffectRecord } from '@runnets/application';
// Built SQLite process proof only. Synthetic footprints confer no native containment evidence.
it('arbitrates one lifetime across built processes and retains interruption uncertainty on two reopens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-process-')),
    path = join(root, 'runtime.sqlite');
  const a = managedLifetimeFixture(),
    b = managedLifetimeFixture('b', '/a', '22222222-2222-2222-2222-222222222222');
  const store = openSqliteStore({ path });
  store.serviceAuthority.atomic((tx) => {
    tx.putConnection(a.connection, null);
    tx.putConnection(b.connection, null);
  });
  store.close();
  let one = child('managed-workspace-journal.test.ts', [path], process.env);
  const two = child('managed-workspace-journal.test.ts', [path], process.env);
  try {
    await Promise.all([one.ready, two.ready]);
    const winners = await Promise.all([
      one.call('claim', { claim: a.claim, facts: { pairs: [] } }),
      two.call('claim', { claim: b.claim, facts: { pairs: [] } }),
    ]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const before = await two.call<ToolEffectRecord[]>('pending');
    expect(before).toMatchObject([{ outcome: 'started', taskRunId: '\0managed-stdio/v1' }]);
    await one.kill();
    await two.kill();
    for (let n = 0; n < 2; n++) {
      one = child('managed-workspace-journal.test.ts', [path], process.env);
      await one.ready;
      await one.call('recover');
      expect(await one.call('pending')).toEqual([{ ...before[0], outcome: 'uncertain' }]);
      expect(await one.call('claim', { claim: a.claim, facts: { pairs: [] } })).toBe(false);
      expect(await one.call('claim', { claim: b.claim, facts: { pairs: [] } })).toBe(false);
      await one.call('close');
      await one.kill();
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM events').get()?.['n']).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await one.kill();
    await two.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
