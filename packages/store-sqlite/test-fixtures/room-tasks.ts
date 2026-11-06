/* eslint-disable no-restricted-imports -- Test-only SQLite construction in this package. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ABSENT,
  canonicalJson,
  decide,
  replay,
  taskRunId,
  conversationId,
  workspaceId,
  unlimitedBudget,
  type AnyCommand,
  type CommandType,
  type CommandPayloads,
  type TaskRunAggregate,
  type ModelActivationSnapshot,
} from '@runnets/domain';
import type { RoomTaskReceipt } from '@runnets/application';
import {
  RoomTaskPersistence,
  unconfiguredModelConnection,
  type RoomTaskStart,
} from '@runnets/application';
import { openSqliteStore } from '../src/index.js';
import { DatabaseSync } from 'node:sqlite';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export function roomTasks(requestedPath?: string) {
  const directory = requestedPath === undefined ? mkdtempSync(join(tmpdir(), 'room-task-')) : null;
  const path = requestedPath ?? join(directory!, 'store.sqlite');
  const store = openSqliteStore({ path });
  const db = path === ':memory:' ? null : new DatabaseSync(path);
  let id = 0;
  store.modelConnections.put(
    {
      ...unconfiguredModelConnection('fixture'),
      connectionId: 'cloud',
      revision: 1,
      intent: 'active',
      endpoint: 'https://fixture.invalid',
      defaultModelId: 'one',
    },
    null,
  );

  store.conversations.atomic((tx) => {
    tx.putWorkspace({ id: 'ws_fixture', root: '/fixture' });
    for (const botId of ['a', 'b', 'c']) {
      tx.putBot({
        id: botId,
        workspaceId: 'ws_fixture',
        handle: botId,
        name: botId,
        role: 'assistant',
        provider: 'fixture',
        model: 'one',
        profileVersion: 1,
      });
      tx.putModelBinding(botId, { connectionId: 'cloud', modelId: 'one' });
    }
    tx.putRoom({
      id: 'room',
      workspaceId: 'ws_fixture',
      kind: 'group',
      title: 'Team',
      botIds: ['a', 'b', 'c'],
    });
  });
  const input: RoomTaskStart = {
    workspaceId: 'ws_fixture',
    roomId: 'room',
    requestId: 'start',
    text: 'work',
    initialBotIds: ['a', 'b'],
    participants: ['a', 'b', 'c'].map((botId) => ({ botId, grantReferences: [] })),
    mandate: { projectId: null, codingTaskId: null, permissions: [] },
  };
  const service = new RoomTaskPersistence({
    store: store.conversations,
    ownerId: 'owner',
    clock: { now: () => new Date('2026-11-06T00:00:00Z') },
    nextId: () => `d_${++id}`,
    sha256,
  });
  return {
    store,
    db,
    service,
    input,
    close() {
      db?.close();
      store.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Test-only attachment of a real queued input to a real committed settled Core attempt. */
export async function attachRoomActor(
  f: ReturnType<typeof roomTasks>,
  receipt: RoomTaskReceipt,
  botId = 'a',
  profileVersion = 1,
) {
  const delivery = receipt.deliveries.find((d) => d.botId === botId)!;
  const pin = f.store.conversations.atomic((tx) => {
    const root = tx.roomTasks!.task(receipt.rootId)!;
    if (root.kind !== 'root') throw Error('fixture root');
    return root.rootPayload.members.find((m) => m.botId === botId)!;
  });
  const activation: ModelActivationSnapshot = {
    version: 1,
    identity: pin.identity,
    capabilities: {
      tools: true,
      streaming: true,
      inputModalities: ['text'],
      contextTokens: null,
      maxOutputTokens: null,
      usage: 'reported',
    },
    limits: { maxModelRequests: 4, requestTimeoutMs: 60000, turnTimeoutMs: 600000 },
    admittedAt: '2026-11-06T00:00:00Z',
    deadlineAt: '2026-11-06T00:10:00Z',
  };
  const turnId = `turn_${delivery.taskId}`,
    runId = `tr_${turnId}`,
    attemptId = `at_${turnId}`;
  f.store.conversations.atomic((tx) =>
    tx.putChatTurn({
      id: turnId,
      workspaceId: 'ws_fixture',
      roomId: 'room',
      requestId: `execute_${delivery.taskId}`,
      taskRunId: runId,
      inboundMessageId: receipt.messageId,
      readThroughSeq: receipt.seq,
      bot: { ...tx.bot(botId)!, profileVersion },
      modelBinding: { connectionId: pin.identity.connectionId, modelId: pin.identity.modelId },
      activation,
      roomDelivery: { version: 1, taskId: delivery.taskId, deliveryId: delivery.deliveryId },
      status: 'dispatching',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    }),
  );
  f.db!.prepare("UPDATE ocean_room_deliveries SET state='claimed' WHERE id=?").run(
    delivery.deliveryId,
  );
  let state: TaskRunAggregate = ABSENT;
  const steps: [CommandType, CommandPayloads[CommandType]][] = [
    [
      'CreateTaskRun',
      {
        conversationId: conversationId('cv_room'),
        workspaceId: workspaceId('ws_ws_fixture'),
        parentTaskRunId: null,
        model: 'one',
        policyId: 'pl_fixture',
        budget: unlimitedBudget(),
      },
    ],
    ['Admit', {}],
    ['Schedule', {}],
    ['StartAttempt', { attemptId, reason: 'initial', provider: 'fixture', model: 'one' }],
    ['StartModelRequest', { attemptId, ordinal: 1, activation, startedAt: '2026-11-06T00:00:01Z' }],
    [
      'SettleModelRequest',
      {
        attemptId,
        ordinal: 1,
        finishedAt: '2026-11-06T00:00:02Z',
        completion: { kind: 'terminal', stopReason: 'tool_calls' },
        usage: { kind: 'actual', tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      },
    ],
  ];
  for (const [type, payload] of steps) {
    const cmd = {
      type,
      payload,
      taskRunId: taskRunId(runId),
      expectedVersion: state.version,
      commandId: `cm_${runId}_${state.version}`,
      actor: { kind: 'runtime', id: 'fixture' },
    } as AnyCommand;
    const decision = decide(state, cmd);
    if (!decision.ok) throw Error(canonicalJson(decision.error));
    const committed = await f.store.log.commands!.commit(cmd, state.version, decision.value, {
      correlationId: 'fixture',
      actorId: 'fixture',
      timestamp: '2026-11-06T00:00:02Z',
    });
    if (!committed.ok) throw committed.error;
    state = replay(await f.store.log.load(taskRunId(runId)));
  }
  return { turnId, taskRunId: runId, attemptId, callId: `${attemptId}_r1_call` };
}
export function roomTaskCounts(f: ReturnType<typeof roomTasks>) {
  return Object.fromEntries(
    ['ocean_room_tasks', 'ocean_room_deliveries', 'ocean_messages', 'ocean_receipts', 'events'].map(
      (t) => [t, Number(f.db!.prepare(`SELECT count(*) AS n FROM ${t}`).get()?.['n'])],
    ),
  );
}
