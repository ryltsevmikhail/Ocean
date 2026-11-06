import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { RoomTaskPersistence } from '@runnets/application';
import { openSqliteStore } from './index.js';
import {
  hostedRoomTasks,
  attachRoomActor,
  sha256,
  roomTaskCounts,
} from '../test-fixtures/room-tasks.js';
it('rolls back start and delegate at the final receipt write, reopening with unchanged counters', async () => {
  const f = hostedRoomTasks();
  try {
    const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
    const before = roomTaskCounts(f);
    f.db!.exec(
      "CREATE TRIGGER reject_room_receipt BEFORE INSERT ON ocean_receipts BEGIN SELECT RAISE(ABORT,'receipt rollback'); END",
    );
    expect(() => f.service.startHosted(f.input)).toThrow('receipt rollback');
    expect(roomTaskCounts(f)).toEqual(before);
    f.db!.exec('DROP TRIGGER reject_room_receipt');
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      prior = roomTaskCounts(f);
    f.db!.exec(
      "CREATE TRIGGER reject_room_receipt BEFORE INSERT ON ocean_receipts BEGIN SELECT RAISE(ABORT,'receipt rollback'); END",
    );
    expect(() => f.service.send(actor, { kind: 'delegate', toBotId: 'b', text: 'do it' })).toThrow(
      'receipt rollback',
    );
    expect(roomTaskCounts(f)).toEqual(prior);
    const second = openSqliteStore({ path });
    try {
      expect(
        second.conversations.atomic(
          (tx) => tx.roomTasks!.task(start.value.deliveries[0]!.taskId)?.status,
        ),
      ).toBe('ready');
    } finally {
      second.close();
    }
    f.db!.exec('DROP TRIGGER reject_room_receipt');
    expect(f.service.send(actor, { kind: 'delegate', toBotId: 'b', text: 'do it' }).ok).toBe(true);
    expect(f.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.close();
  }
});
it('replays immutable receipts after wait, stop and sender roster removal', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = {
        kind: 'delegate',
        toBotId: 'b',
        text: 'opaque [Ocean Desktop attachments v1] text',
      };
    const sent = f.service.send(actor, request);
    expect(sent.ok).toBe(true);
    f.db!.prepare("UPDATE ocean_room_tasks SET status='stopped' WHERE id=?").run(
      start.value.rootId,
    );
    f.db!.exec("DELETE FROM ocean_members WHERE room_id='room' AND bot_id='a'");
    const counts = roomTaskCounts(f);
    expect(f.service.send(actor, request)).toEqual(sent);
    for (const changed of [
      { ...request, text: 'changed' },
      { ...request, toBotId: 'c' },
      { ...request, kind: 'message' },
    ])
      expect(f.service.send(actor, changed)).toMatchObject({
        ok: false,
        error: { code: 'request_conflict' },
      });
    expect(f.service.startHosted(f.input)).toEqual(start);
    expect(roomTaskCounts(f)).toEqual(counts);
    const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
    const second = openSqliteStore({ path });
    try {
      const replay = new RoomTaskPersistence({
        ...f.service.deps,
        store: second.conversations,
        clock: {
          now: () => {
            throw Error('replay clock');
          },
        },
        nextId: () => {
          throw Error('replay allocation');
        },
      });
      expect(replay.send(actor, request)).toEqual(sent);
      expect(replay.start(f.input)).toEqual(start);
    } finally {
      second.close();
    }
  } finally {
    f.close();
  }
});
it('rejects both cross-kind collisions without replacement keys or writes', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'b', text: 'hello' };
    const key =
      'room-agent/v1:' +
      sha256(JSON.stringify(['room-agent/v1', actor.turnId, actor.attemptId, actor.callId]));
    expect(f.service.startHosted({ ...f.input, requestId: key }).ok).toBe(true);
    const before = roomTaskCounts(f);
    expect(f.service.send(actor, request)).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(roomTaskCounts(f)).toEqual(before);
    const other = { ...actor, callId: actor.callId + '2' },
      sent = f.service.send(other, request);
    expect(sent.ok).toBe(true);
    const otherKey =
      'room-agent/v1:' +
      sha256(JSON.stringify(['room-agent/v1', other.turnId, other.attemptId, other.callId]));
    const after = roomTaskCounts(f);
    expect(f.service.startHosted({ ...f.input, requestId: otherKey })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(roomTaskCounts(f)).toEqual(after);
  } finally {
    f.close();
  }
});
it('races identical starts in independent workers with bounded SQLite locking', async () => {
  const f = hostedRoomTasks();
  try {
    const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
    const source = `const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {RoomTaskPersistence}=await import(workerData.app);const {openSqliteStore}=await import(workerData.store);
      const {createHash,randomUUID}=require('node:crypto');const store=openSqliteStore({path:workerData.path,busyTimeoutMs:2000});
      try{const service=new RoomTaskPersistence({store:store.conversations,ownerId:'owner',clock:{now:()=>new Date('2026-11-06T00:00:00Z')},nextId:()=>randomUUID(),sha256:s=>createHash('sha256').update(s).digest('hex')});
      parentPort.postMessage(service.start(workerData.input));}finally{store.close();}})().catch(e=>{throw e;});`;
    const run = () =>
      new Promise<unknown>((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: {
            path,
            input: f.input,
            app: new URL('../../application/dist/index.js', import.meta.url).href,
            store: new URL('../dist/index.js', import.meta.url).href,
          },
        });
        worker.once('message', resolve);
        worker.once('error', reject);
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(roomTaskCounts(f)).toMatchObject({
      ocean_room_tasks: 3,
      ocean_room_deliveries: 2,
      ocean_messages: 1,
      ocean_receipts: 1,
      events: 0,
    });
  } finally {
    f.close();
  }
});

it('replays a lost peer receipt after actual selected-grant revocation with an otherwise eligible actor', async () => {
  const { ownerGrant } = await import('../../../test-fixtures/service-authority.js');
  const f = hostedRoomTasks();
  try {
    f.store.serviceAuthority.atomic((tx) =>
      tx.putGrant(
        {
          ...ownerGrant,
          id: 'replay-grant',
          subject: {
            ...ownerGrant.subject,
            workspaceId: f.input.workspaceId,
            roomId: 'room',
            botId: 'b',
            projectId: sha256('/fixture'),
          },
        },
        null,
      ),
    );
    const input = {
      ...f.input,
      participants: f.input.participants.map((p) =>
        p.botId === 'b' ? { ...p, grantReferences: [{ grantId: 'replay-grant', revision: 1 }] } : p,
      ),
    };
    const start = f.service.startHosted(input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'b', text: 'committed before revocation' };
    const receipt = f.service.send(actor, request);
    expect(receipt.ok).toBe(true);
    expect(
      f.store.serviceAuthority.atomic((tx) => {
        const old = tx.grant('replay-grant')!;
        return tx.putGrant({ ...old, state: 'revoked', revision: 2 }, 1);
      }),
    ).toBe(true);
    expect(f.store.serviceAuthority.atomic((tx) => tx.grant('replay-grant'))).toMatchObject({
      state: 'revoked',
      revision: 2,
    });
    expect(
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.origin(actor.turnId, actor.taskRunId, actor.attemptId, true),
      ),
    ).not.toBeNull();
    const before = roomTaskCounts(f);
    expect(f.service.send(actor, request)).toEqual(receipt);
    expect(f.service.startHosted(input)).toEqual(start);
    expect(roomTaskCounts(f)).toEqual(before);
  } finally {
    f.close();
  }
});
