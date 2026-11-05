import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRunService } from '@runnets/application';
import { taskRunId } from '@runnets/domain';
import { command, setup } from '../test-fixtures/atomic-command.js';
import { SqliteEventLog } from './event-log.js';
import { createDurableIdGenerator } from './id-source.js';
import { initializeSchema } from './schema.js';

it('rolls back events and receipt when disposition commit receipt insertion fails', async () => {
  const { db, service, log } = setup();
  try {
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);
    await expect(service.executeWithDisposition(command)).rejects.toThrow('receipt rejected');
    expect(await log.load(command.taskRunId)).toHaveLength(0);
    expect(await service.lookupCommand(command)).toEqual({ ok: true, value: null });
    db.exec('DROP TRIGGER reject_receipt');
    expect(await service.executeWithDisposition(command)).toMatchObject({
      ok: true,
      value: { disposition: 'committed' },
    });
  } finally {
    db.close();
  }
});

it('preserves receipt JSON across both APIs and closing and reopening SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-disposition-'));
  const path = join(directory, 'fixture.db');
  const open = () => {
    const db = new DatabaseSync(path);
    initializeSchema(db);
    const ids = createDurableIdGenerator(db);
    const log = new SqliteEventLog(db, ids);
    return { db, service: new TaskRunService({ log, ids, clock: { now: () => new Date(0) } }) };
  };
  let fixture = open();
  try {
    const original = await fixture.service.execute(command);
    if (!original.ok) throw original.error;
    const second = { ...command, commandId: 'cm_new_api', taskRunId: taskRunId('tr_new_api') };
    const fresh = await fixture.service.executeWithDisposition(second);
    if (!fresh.ok) throw fresh.error;
    expect(fresh.value.disposition).toBe('committed');
    expect(Object.keys(fresh.value.receipt)).toEqual([
      'commandId',
      'taskRunId',
      'version',
      'events',
    ]);
    const originals = [
      [command, JSON.stringify(original.value)],
      [second, JSON.stringify(fresh.value.receipt)],
    ] as const;
    fixture.db.close();
    fixture = open();
    const advanced = await fixture.service.execute({
      type: 'Admit',
      commandId: 'cm_advance',
      taskRunId: command.taskRunId,
      expectedVersion: original.value.version,
      actor: command.actor,
      payload: {},
    });
    expect(advanced.ok).toBe(true);
    const rows = () =>
      JSON.stringify({
        receipts: fixture.db.prepare('SELECT * FROM command_receipts ORDER BY command_id').all(),
        events: fixture.db.prepare('SELECT * FROM events ORDER BY aggregate_id,sequence').all(),
        meta: fixture.db.prepare('SELECT * FROM meta ORDER BY key').all(),
      });
    for (const [request, bytes] of originals) {
      for (const api of ['execute', 'executeWithDisposition'] as const) {
        const before = rows();
        const replay = await fixture.service[api](request);
        if (!replay.ok) throw replay.error;
        const receipt = 'receipt' in replay.value ? replay.value.receipt : replay.value;
        expect(JSON.stringify(receipt)).toBe(bytes);
        if ('disposition' in replay.value) expect(replay.value.disposition).toBe('replayed');
        expect(rows()).toBe(before);
        expect(JSON.stringify(receipt)).not.toContain('request_binding');
      }
    }
  } finally {
    fixture.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
