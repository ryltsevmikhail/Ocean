import { SqliteOwnerDecisions } from './owner-decisions.js';
import { expect, it } from 'vitest';
import { openDatabase } from './schema.js';
import { roomRuntimeReads } from './room-runtime-reads.js';

it('projects the exact run’s unexpired pending decision IDs and redacts restricted journal events', () => {
  const db = openDatabase(':memory:', 5000);
  try {
    db.exec(`INSERT INTO ocean_workspace VALUES(1,'ws','/fixture');
      INSERT INTO ocean_bots VALUES('bot','ws','dev','Dev','private role','test','test',1);
      INSERT INTO ocean_rooms VALUES('room','ws','direct','bot',NULL);
      INSERT INTO ocean_members VALUES('ws','room','bot');`);
    const binding = {
      workspaceId: 'ws',
      roomId: 'room',
      runId: 'tr_one',
      taskId: 'task',
      botId: 'bot',
    };
    const turn = {
      ...binding,
      id: 'turn',
      taskRunId: 'tr_one',
      status: 'dispatching',
      codingTaskId: 'task',
      bot: { id: 'bot' },
      inboundMessageId: 'msg',
      requestId: 'req',
    };
    db.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?,NULL)').run(
      'turn',
      'ws',
      'room',
      'tr_one',
      'dispatching',
      JSON.stringify(turn),
    );
    const now = Date.now();
    for (const [id, change, expiresAt, status] of [
      ['valid', {}, now + 300000, 'pending'],
      ['wrong-room', { roomId: 'other' }, now + 300000, 'pending'],
      ['expired', {}, now - 1, 'pending'],
      ['consumed', {}, now + 300000, 'consumed'],
      ['wrong-task', { taskId: 'other' }, now + 300000, 'pending'],
      ['wrong-bot', { botId: 'other' }, now + 300000, 'pending'],
    ] as const) {
      new SqliteOwnerDecisions(db).insert(
        {
          ...binding,
          decisionId: id,
          kind: 'write',
          createdAt: expiresAt - 300000,
          expiresAt,
          previewLength: 5,
          bindingDigest: 'a'.repeat(64),
          status: 'pending',
          version: 1,
        },
        'exact',
      );
      db.prepare('INSERT INTO ocean_coding_approvals VALUES(?,?)').run(
        id,
        JSON.stringify({
          id,
          binding: { ...binding, ...change },
          createdAt: expiresAt - 300000,
          expiresAt,
          status,
          preview: 'private arguments',
        }),
      );
    }
    db.prepare(
      "INSERT INTO events VALUES('tr_one',1,'e','task_run','task_run.created',1,'t',NULL,'c','runtime','private actor','restricted','{}')",
    ).run();
    const reads = roomRuntimeReads(db);
    expect(reads.run(binding)?.pendingDecisionIds).toEqual(['valid']);
    expect(reads.events(binding, 0, 1)).toEqual([
      { sequence: 1, type: 'redacted', sensitivity: 'restricted' },
    ]);
    expect(reads.run({ ...binding, roomId: 'other' })).toBeNull();
  } finally {
    db.close();
  }
});

it('hides abandoned never-dispatched children from run listings and lookups', () => {
  const db = openDatabase(':memory:', 5000);
  try {
    db.exec(`INSERT INTO ocean_workspace VALUES(1,'ws','/fixture');
      INSERT INTO ocean_bots VALUES('bot','ws','dev','Dev','role','test','test',1);
      INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
      INSERT INTO ocean_members VALUES('ws','room','bot');
      INSERT INTO ocean_messages VALUES('note','ws','room',1,'user',NULL,'question','2026-11-04T00:00:00.000Z',NULL,NULL);
      INSERT INTO ocean_broadcast_batches VALUES('batch','ws','room','req','[]','note',1,
        '[{"botId":"bot","handle":"dev","name":"Dev","provider":"test","model":"test","turnId":"abandoned","runId":"tr_abandoned","position":0},{"botId":"bot","handle":"dev","name":"Dev","provider":"test","model":"test","turnId":"started","runId":"tr_started","position":1}]',
        'abandoned',3,'2026-11-04T00:00:00.000Z','2026-11-04T00:00:01.000Z');`);
    const payload = (id: string, abandoned: boolean) =>
      JSON.stringify({
        id,
        workspaceId: 'ws',
        roomId: 'room',
        requestId: 'req',
        taskRunId: 'tr_' + id,
        inboundMessageId: 'note',
        readThroughSeq: 1,
        bot: { id: 'bot' },
        status: 'cancelled',
        text: '',
        preparedVersion: null,
        stopReason: 'end_turn',
        broadcast: {
          version: 1,
          batchId: 'batch',
          position: abandoned ? 0 : 1,
          ...(abandoned ? { abandoned: true } : {}),
        },
      });
    db.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?,NULL)').run(
      'abandoned',
      'ws',
      'room',
      'tr_abandoned',
      'cancelled',
      payload('abandoned', true),
    );
    db.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?,NULL)').run(
      'started',
      'ws',
      'room',
      'tr_started',
      'cancelled',
      payload('started', false),
    );
    const reads = roomRuntimeReads(db);
    const rows = [...reads.runs({ workspaceId: 'ws', roomId: 'room' }, '', 50)];
    expect(rows.map((row) => row.runId)).toEqual(['tr_started']);
    expect(reads.run({ workspaceId: 'ws', roomId: 'room', runId: 'tr_abandoned' })).toBeNull();
    expect(
      reads.cancelTarget({ workspaceId: 'ws', roomId: 'room', runId: 'tr_abandoned' }),
    ).toBeNull();
  } finally {
    db.close();
  }
});
