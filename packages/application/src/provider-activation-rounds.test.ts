import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { DirectChatService } from './direct-chat.js';
import { ProviderActivationService } from './provider-activation.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';
import { activationFixture } from '../test-fixtures/provider-activation.js';
import { terminal, usage } from '../test-fixtures/model-turn.js';
import { fakeSecrets } from '../test-fixtures/provider-connection-fakes.js';
import type { ProviderPort } from './provider.js';

it('retains the persisted snapshot through two tool rounds, source mutation and unrelated rotation', async () => {
  const f = activationFixture();
  const record = {
    ...f.store.read('legacy:scripted')!,
    connectionId: 'selected',
    kind: 'local' as const,
    endpoint: 'http://127.0.0.1:8080',
    auth: 'none' as const,
    intent: 'active' as const,
    revision: 1,
    defaultModelId: 'retired',
  };
  f.store.put(record, null);
  f.store.put({ ...record, connectionId: 'other' }, null);
  f.store.atomic((tx) =>
    tx.putModelBinding(f.bot.id, { connectionId: 'selected', modelId: 'scripted' }),
  );
  let rounds = 0,
    toolCalls = 0;
  const capabilities = { ...f.snapshot.capabilities, inputModalities: ['text' as const] };
  const provider: ProviderPort = {
    ...f.provider,
    async *stream() {
      rounds++;
      yield usage;
      if (rounds <= 2) {
        yield { type: 'tool_call', call: { id: 'tool_' + rounds, name: 'read', arguments: '{}' } };
        yield { ...terminal, stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'answer' };
        yield terminal;
      }
    },
  };
  const descriptors: unknown[] = [];
  const factory: ModelCredentialFactory = {
    catalog: (d) => {
      descriptors.push(d);
      return [{ modelId: 'scripted', capabilities }];
    },
    activate: () => ({
      source: 'auth_none',
      provider,
      check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['scripted'] }),
    }),
    external: () => null,
  };
  const resolver = new ProviderActivationService({
    connections: f.store.modelConnections,
    factory,
    secrets: fakeSecrets(),
    disabled: false,
    restored: false,
  });
  const chat = new DirectChatService({
    ...f,
    grantedTools: {
      forTurn: async (turn) => {
        expect(Object.isFrozen(turn.activation?.limits)).toBe(true);
        expect(Object.isFrozen(turn.activation?.capabilities.inputModalities)).toBe(true);
        capabilities.tools = false;
        return {
          cleanupConfirmed: true,
          definitions: [{ name: 'read', description: 'read', parameters: {} }],
          execute: async () => {
            toolCalls++;
            f.store.put({ ...record, connectionId: 'other', revision: toolCalls + 1 }, toolCalls);
            return { output: 'read', isError: false };
          },
        };
      },
    },
  });
  const admitted = chat.submit({ ...f.request, resolver });
  if (!admitted.ok) throw Error('admission');
  const saved = f.store.atomic((tx) => tx.chatTurns()[0]!.activation);
  expect((await admitted.value.completion)?.status).toBe('completed');
  expect(rounds).toBe(3);
  expect(toolCalls).toBe(2);
  expect(descriptors).toHaveLength(1);
  const events = await f.tasks.events(taskRunId(admitted.value.receipt.runId!));
  const starts = events.filter((event) => event.type === 'attempt.model_request_started');
  expect(starts).toHaveLength(3);
  for (const event of starts) expect(event.payload).toMatchObject({ activation: saved });
  expect(saved).toMatchObject({
    identity: { connectionId: 'selected', connectionRevision: 1, modelId: 'scripted' },
    capabilities: { tools: true },
  });
});
