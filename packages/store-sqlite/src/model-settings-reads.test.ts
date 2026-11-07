import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  BotModelBindingReads,
  BotModelBindingService,
  ConversationService,
  RoomModelExecutionReads,
  RoomModelPolicyService,
  TaskRunService,
  unconfiguredModelConnection,
} from '@runnets/application';
import { unlimitedBudget, taskRunId, conversationId, workspaceId } from '@runnets/domain';
import { SequentialIdGenerator } from '@runnets/store';
import {
  activation,
  provider,
  usage,
  terminal,
} from '../../application/test-fixtures/model-turn.js';
import { runTurn, executeStep } from '@runnets/application';
import { openSqliteStore } from './index.js';
const close: (() => void)[] = [];
afterEach(() => {
  for (const clean of close.splice(0).reverse()) clean();
});
it('reopens exact same-vendor bindings and policy revision while frozen execution identity stays unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-read-'));
  close.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'profile.sqlite');
  const db = openSqliteStore({ path });
  close.push(() => db.close());
  let ids = 0;
  const clock = { now: () => new Date('2026-11-04T00:00:00Z') };
  const conversations = new ConversationService({
    store: db.conversations,
    clock,
    nextId: () => `id_${++ids}`,
  });
  conversations.execute({
    type: 'BindWorkspace',
    workspaceId: 'ws_model_turn',
    requestId: 'bind',
    root: '/fixture',
  });
  const factory = {
    catalog: () => [{ modelId: 'scripted', capabilities: activation().capabilities }],
  };
  for (const connectionId of ['first', 'second'])
    db.modelConnections.put(
      {
        ...unconfiguredModelConnection('scripted'),
        connectionId,
        kind: 'local',
        auth: 'none',
        endpoint: 'http://127.0.0.1:8080',
        defaultModelId: 'scripted',
        revision: 1,
        intent: 'disconnected',
      },
      null,
    );
  const bindings = new BotModelBindingService({
    store: db.conversations,
    connections: db.modelConnections,
    factory,
    nextId: () => `bot_${++ids}`,
  });
  const first = bindings.create({
    workspaceId: 'ws_model_turn',
    requestId: 'first',
    handle: 'first',
    name: 'First',
    role: 'helper',
    binding: { connectionId: 'first', modelId: 'scripted' },
  });
  const second = bindings.create({
    workspaceId: 'ws_model_turn',
    requestId: 'second',
    handle: 'second',
    name: 'Second',
    role: 'helper',
    binding: { connectionId: 'second', modelId: 'scripted' },
  });
  if (!first.ok || !second.ok) throw Error('fixture');
  const room = conversations.execute({
    type: 'OpenDirectRoom',
    workspaceId: 'ws_model_turn',
    requestId: 'room',
    botId: first.value.bot.id,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('fixture');
  const scope = { workspaceId: 'ws_model_turn', roomId: room.value.data.id };
  const policy = new RoomModelPolicyService({
    store: db.conversations,
    connections: db.modelConnections,
  });
  expect(
    policy.set({ ...scope, requestId: 'policy', expectedRevision: 1, cloudTransfer: 'allow' }).ok,
  ).toBe(true);
  const service = new TaskRunService({ log: db.log, clock, ids: new SequentialIdGenerator() });
  const runId = taskRunId('tr_model_turn');
  const created = await executeStep(
    service,
    runId,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_' + scope.roomId),
      workspaceId: workspaceId('ws_' + scope.workspaceId),
      parentTaskRunId: null,
      model: 'scripted',
      policyId: 'pl_model_turn',
      budget: unlimitedBudget(),
    },
    0,
  );
  if (!created.ok) throw created.error;
  const input = {
    service,
    taskRunId: runId,
    clock,
    provider: provider([usage, terminal]),
    model: 'scripted',
    messages: [],
    signal: new AbortController().signal,
    emit: () => {},
  };
  const snapshot = {
    ...activation(),
    identity: {
      source: 'connection' as const,
      connectionId: 'first',
      providerId: 'scripted',
      modelId: 'scripted',
      connectionRevision: 1,
      botProfileVersion: 1,
      kind: 'local' as const,
      endpoint: 'http://127.0.0.1:8080',
      auth: 'none' as const,
      artifactDigest: null,
      backendVersion: null,
    },
  };
  await runTurn({ ...input, activation: snapshot });
  db.conversations.atomic((tx) =>
    tx.putChatTurn({
      ...scope,
      id: 'turn',
      taskRunId: input.taskRunId,
      requestId: 'turn',
      inboundMessageId: 'message',
      readThroughSeq: 0,
      bot: first.value.bot,
      status: 'completed',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    }),
  );
  const query = { ...scope, runId: input.taskRunId };
  const before = await new RoomModelExecutionReads({
    store: db.conversations,
    tasks: input.service,
  }).get(query);
  db.close();
  const reopened = openSqliteStore({ path });
  close.push(() => reopened.close());
  expect(
    new BotModelBindingReads(reopened.conversations).list({ workspaceId: scope.workspaceId }).items,
  ).toEqual([first.value, second.value]);
  expect(
    new RoomModelPolicyService({
      store: reopened.conversations,
      connections: reopened.modelConnections,
    }).get(scope),
  ).toMatchObject({ ok: true, value: { policy: { revision: 2 } } });
  const next = new BotModelBindingService({
    store: reopened.conversations,
    connections: reopened.modelConnections,
    factory,
    nextId: () => 'unused',
  });
  expect(
    next.set({
      workspaceId: scope.workspaceId,
      botId: first.value.bot.id,
      requestId: 'rebind',
      expectedProfileVersion: 1,
      binding: second.value.binding,
    }).ok,
  ).toBe(true);
  const tasks = new TaskRunService({
    log: reopened.log,
    clock,
    ids: { eventId: () => 'unused', commandId: () => 'unused' },
  });
  expect(
    await new RoomModelExecutionReads({ store: reopened.conversations, tasks }).get(query),
  ).toEqual(before);
  expect(before.execution?.usage).toMatchObject({
    completeness: 'complete',
    requestCounts: { actual: 1 },
  });
  expect(before.execution?.identity).toMatchObject({ connectionId: 'first', botProfileVersion: 1 });
});
