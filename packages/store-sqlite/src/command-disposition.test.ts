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
    expect(Object.keys(original.value)).toEqual(['commandId', 'taskRunId', 'version', 'events']);
    expect(Object.keys(fresh.value)).toEqual(['receipt', 'disposition']);
    expect(JSON.stringify(fresh.value)).not.toContain('request_binding');
    const originals = [
      [command, original.value],
      [second, fresh.value.receipt],
    ] as const;
    for (const [request, receipt] of originals) {
      const stored = fixture.db
        .prepare('SELECT events FROM command_receipts WHERE command_id=?')
        .get(request.commandId);
      expect(stored?.['events']).toBe(JSON.stringify(receipt.events));
    }
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
    for (const [request, retained] of originals) {
      const bytes = JSON.stringify(retained);
      for (const api of ['execute', 'executeWithDisposition'] as const) {
        const before = rows();
        if (api === 'execute') {
          const replay = await fixture.service.execute(request);
          expect(replay).toEqual({ ok: true, value: retained });
          if (!replay.ok) throw replay.error;
          expect(Object.keys(replay.value)).toEqual([
            'commandId',
            'taskRunId',
            'version',
            'events',
          ]);
          expect(JSON.stringify(replay.value)).toBe(bytes);
          expect(JSON.stringify(replay)).not.toContain('request_binding');
        } else {
          const replay = await fixture.service.executeWithDisposition(request);
          expect(replay).toEqual({
            ok: true,
            value: { receipt: retained, disposition: 'replayed' },
          });
          if (!replay.ok) throw replay.error;
          expect(Object.keys(replay.value)).toEqual(['receipt', 'disposition']);
          expect(Object.keys(replay.value.receipt)).toEqual([
            'commandId',
            'taskRunId',
            'version',
            'events',
          ]);
          expect(JSON.stringify(replay.value.receipt)).toBe(bytes);
          expect(JSON.stringify(replay)).not.toContain('request_binding');
        }
        expect(rows()).toBe(before);
      }
    }
  } finally {
    fixture.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
