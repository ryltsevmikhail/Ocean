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
