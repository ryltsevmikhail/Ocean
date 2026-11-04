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
    const before = fixture.db.prepare('SELECT * FROM command_receipts ORDER BY command_id').all();
    expect(before[0]?.['events']).toBe(JSON.stringify(original.value.events));
    expect(before[1]?.['events']).toBe(JSON.stringify(fresh.value.receipt.events));
    fixture.db.close();
    fixture = open();
    expect(await fixture.service.executeWithDisposition(command)).toEqual({
      ok: true,
      value: { receipt: original.value, disposition: 'replayed' },
    });
    expect(await fixture.service.execute(command)).toEqual(original);
    expect(fixture.db.prepare('SELECT * FROM command_receipts').all()).toEqual(before);
    expect(JSON.stringify(await fixture.service.executeWithDisposition(command))).not.toContain(
      'request_binding',
    );
  } finally {
    fixture.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
