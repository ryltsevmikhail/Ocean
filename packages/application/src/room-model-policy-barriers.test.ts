import { expect, it } from 'vitest';
import { BotModelBindingService } from './bot-model-binding.js';
import { DirectChatService } from './direct-chat.js';
import { ProviderActivationService } from './provider-activation.js';
import { RoomModelPolicyService } from './room-model-policy.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';
import type { ProviderPort } from './provider.js';
import { activationFixture } from '../test-fixtures/provider-activation.js';
import { fakeSecrets } from '../test-fixtures/provider-connection-fakes.js';
import { terminal, usage } from '../test-fixtures/model-turn.js';

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(twoRounds: boolean) {
  const f = activationFixture();
  const entered = gate(),
    resume = gate();
  const cloud = {
    ...f.store.read('legacy:scripted')!,
    endpoint: 'https://cloud.example',
    secretRef: 'fixture-ref',
    intent: 'active' as const,
    revision: 1,
  };
  f.store.put(cloud, 0);
  f.store.put(
    {
      ...cloud,
      connectionId: 'local',
      kind: 'local',
      auth: 'none',
      endpoint: 'http://127.0.0.1:1234',
      secretRef: null,
    },
    null,
  );
  const secrets = fakeSecrets();
  secrets.values.set('fixture-ref', 'fixture-key');
  let calls = 0;
  const provider: ProviderPort = {
    ...f.provider,
    async *stream() {
      calls++;
      expect(f.store.atomic((tx) => tx.roomModelPolicy(f.request.roomId)?.cloudTransfer)).toBe(
        'allow',
      );
      yield usage;
      if (twoRounds && calls === 1) {
        yield { type: 'tool_call', call: { id: 'read_1', name: 'read', arguments: '{}' } };
        yield { ...terminal, stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'answer' };
        yield terminal;
      }
    },
  };
  const factory: ModelCredentialFactory = {
    catalog: () => [{ modelId: 'scripted', capabilities: f.snapshot.capabilities }],
    activate: (record) => ({
      source: record.kind === 'local' ? 'auth_none' : 'saved',
      provider,
      check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['scripted'] }),
    }),
    external: () => {
      throw Error('no fallback');
    },
  };
  const resolver = new ProviderActivationService({
    connections: f.store,
    secrets,
    factory,
    disabled: false,
    restored: false,
  });
  const policy = new RoomModelPolicyService({ store: f.store, connections: f.store });
  const binding = new BotModelBindingService({
    store: f.store,
    connections: f.store,
    factory,
    nextId: f.nextId,
  });
  const chat = new DirectChatService({
    ...f,
    grantedTools: {
      forTurn: async () => {
        if (!twoRounds) {
          entered.release();
          await resume.promise;
          return null;
        }
        return {
          cleanupConfirmed: true,
          definitions: [{ name: 'read', description: 'read', parameters: {} }],
          execute: async () => {
            entered.release();
            await resume.promise;
            return { output: 'result', isError: false };
          },
        };
      },
    },
  });
  const input = {
    workspaceId: f.request.workspaceId,
    roomId: f.request.roomId,
    requestId: 'deny',
    expectedRevision: 1,
    cloudTransfer: 'deny' as const,
  };
  return { ...f, entered, resume, resolver, policy, binding, chat, input, calls: () => calls };
}

it.each([false, true])(
  'deny conflicts at frozen cloud barrier (between rounds=%s), then succeeds after settlement',
  async (twoRounds) => {
    const f = fixture(twoRounds);
    const result = f.chat.submit({ ...f.request, resolver: f.resolver });
    if (!result.ok) throw Error('admission');
    await f.entered.promise;
    const before = f.store.atomic((tx) => tx.chatTurns()[0]!);
    expect(before.status).toBe(twoRounds ? 'dispatching' : 'accepted');
    expect(f.calls()).toBe(twoRounds ? 1 : 0);
    expect(
      f.binding.set({
        workspaceId: f.request.workspaceId,
        requestId: 'rebind',
        botId: f.bot.id,
        expectedProfileVersion: 1,
        binding: { connectionId: 'local', modelId: 'scripted' },
      }).ok,
    ).toBe(true);
    expect(f.policy.set(f.input)).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
    expect(
      f.store.atomic((tx) => [
        tx.roomModelPolicy(f.request.roomId),
        tx.chatTurns()[0]!.activation,
        tx.receipt('deny'),
      ]),
    ).toEqual([
      { roomId: f.request.roomId, cloudTransfer: 'allow', revision: 1 },
      before.activation,
      null,
    ]);
    f.resume.release();
    expect((await result.value.completion)?.status).toBe('completed');
    expect(f.calls()).toBe(twoRounds ? 2 : 1);
    expect(f.policy.set(f.input)).toMatchObject({
      ok: true,
      value: { cloudTransfer: 'deny', revision: 2 },
    });
    expect(f.chat.submit({ ...f.request, resolver: f.resolver }).ok).toBe(true);
    expect(f.calls()).toBe(twoRounds ? 2 : 1);
  },
);
