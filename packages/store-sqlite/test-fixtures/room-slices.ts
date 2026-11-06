import { ok, type ModelActivationSnapshot } from '@runnets/domain';
import {
  TaskRunService,
  claimRoomDelivery,
  executeChatTurn,
  type ProviderActivationPort,
  type ProviderPort,
  type ModelRequest,
  type ProviderEvent,
} from '@runnets/application';
import { roomTasks } from './room-tasks.js';
export const usage = {
  type: 'usage',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
} as const;
export const answer = (text: string): readonly ProviderEvent[] => [
  { type: 'text_delta', text },
  usage,
  { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
];
export const delegate = (toBotId: string, text: string): readonly ProviderEvent[] => [
  {
    type: 'tool_call',
    call: { id: 'delegate', name: 'room_delegate', arguments: JSON.stringify({ toBotId, text }) },
  },
  {
    type: 'tool_call',
    call: {
      id: 'suffix',
      name: 'room_delegate',
      arguments: JSON.stringify({ toBotId: 'c', text: 'must not execute' }),
    },
  },
  usage,
  { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
];
export function roomSlices(
  rounds: readonly (readonly ProviderEvent[])[],
  textOnlyBotIds: readonly string[] = ['b'],
  path?: string,
) {
  const f = roomTasks(path);
  let id = 1000,
    now = Date.parse('2026-11-06T00:00:00Z');
  const requests: ModelRequest[] = [];
  const provider: ProviderPort = {
    id: 'fixture',
    models: ['one'],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    async *stream(request) {
      const events = rounds[requests.length];
      requests.push(request);
      if (!events) throw Error('unexpected model request');
      yield* events;
    },
  };
  const clock = { now: () => new Date(now) };
  const resolver: ProviderActivationPort = {
    resolve(bound, at) {
      const snapshot: ModelActivationSnapshot = {
        version: 1,
        identity: {
          source: 'connection',
          connectionId: 'cloud',
          connectionRevision: 1,
          kind: 'cloud',
          providerId: bound.bot.provider,
          modelId: bound.binding.modelId,
          botProfileVersion: bound.bot.profileVersion,
          endpoint: 'https://fixture.invalid',
          auth: 'api_key',
          artifactDigest: null,
          backendVersion: null,
        },
        capabilities: {
          tools: !textOnlyBotIds.includes(bound.bot.id),
          streaming: true,
          inputModalities: ['text'],
          contextTokens: null,
          maxOutputTokens: null,
          usage: 'reported',
        },
        limits: { maxModelRequests: 4, requestTimeoutMs: 60000, turnTimeoutMs: 600000 },
        admittedAt: at,
        deadlineAt: new Date(Date.parse(at) + 600000).toISOString(),
      };
      return ok({ provider, snapshot });
    },
  };
  const tasks = new TaskRunService({
    log: f.store.log,
    clock,
    ids: { eventId: () => `event_${++id}`, commandId: () => `cmd_${++id}` },
  });
  const deps = { ...f.service.deps, tasks, clock, resolver, nextId: () => `slice_${++id}` };
  return {
    ...f,
    tasks,
    deps,
    requests,
    advance(ms: number) {
      now += ms;
    },
    start() {
      const result = f.service.start({ ...f.input, initialBotIds: ['a'] });
      if (!result.ok) throw Error('start failed');
      return result.value;
    },
    claim(deliveryId: string) {
      return claimRoomDelivery(deps, deliveryId);
    },
    async execute(deliveryId: string) {
      const claim = claimRoomDelivery(deps, deliveryId);
      if (claim.kind !== 'claimed') throw Error(`expected claim: ${claim.kind}`);
      return executeChatTurn(
        deps,
        { ...claim, signal: new AbortController().signal, emit() {} },
        { parentRunId: claim.parentRunId, tools: claim.tools },
      );
    },
    deliveries(taskId: string) {
      return f.store.conversations.atomic((tx) => tx.roomTasks!.inputs(taskId));
    },
    turns() {
      return f.store.conversations.atomic((tx) => tx.chatTurns());
    },
  };
}
