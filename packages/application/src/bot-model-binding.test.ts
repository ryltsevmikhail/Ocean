import { describe, expect, it } from 'vitest';
import {
  BotModelBindingService,
  unconfiguredModelConnection,
  type ConversationStore,
} from '@runnets/application';
import type { BoundBot, ConversationResult } from '@runnets/domain';
import { bindingFixture, createBinding } from '../test-fixtures/bot-model-binding.js';

function value(result: ConversationResult<BoundBot>) {
  if (!result.ok) throw Error(result.error.code);
  return result.value;
}
const setBinding = {
  workspaceId: 'w',
  requestId: 'set',
  botId: 'bot_1',
  expectedProfileVersion: 1,
  binding: { connectionId: 'shared', modelId: 'two' },
};

describe('atomic per-bot model binding', () => {
  it('creates disconnected known bindings and updates exactly one bot independently of defaults', () => {
    const f = bindingFixture();
    const first = value(f.service.create(createBinding));
    const sibling = value(
      f.service.create({
        ...createBinding,
        requestId: 'sibling',
        handle: 'review',
        binding: { connectionId: 'shared', modelId: 'two' },
      }),
    );
    expect(first.bot).toMatchObject({ provider: 'deepseek', model: 'one', profileVersion: 1 });
    const record = f.connections.read('shared');
    if (!record) throw Error('missing record');
    f.connections.put({ ...record, defaultModelId: 'two', revision: 2 }, 1);
    expect(f.store.atomic((tx) => tx.modelBinding(first.bot.id))).toEqual(createBinding.binding);
    expect(f.store.atomic((tx) => tx.modelBinding(sibling.bot.id))).toEqual(sibling.binding);
    const changed = value(f.service.set(setBinding));
    expect(changed).toEqual({
      bot: { ...first.bot, model: 'two', profileVersion: 2 },
      binding: setBinding.binding,
    });
    expect(f.store.atomic((tx) => tx.bot(sibling.bot.id))).toEqual(sibling.bot);
    expect(f.store.atomic((tx) => tx.modelBinding(sibling.bot.id))).toEqual(sibling.binding);
  });

  it('replays frozen snapshots before current connection, catalog or bot reads', () => {
    const f = bindingFixture();
    const created = f.service.create(createBinding);
    const changed = f.service.set(setBinding);
    f.service.set({
      ...setBinding,
      requestId: 'later',
      expectedProfileVersion: 2,
      binding: { connectionId: 'shared', modelId: 'one' },
    });
    const replay = new BotModelBindingService({
      store: f.store,
      connections: {
        read: () => {
          throw Error('must not read');
        },
      },
      factory: {
        catalog: () => {
          throw Error('must not catalog');
        },
      },
      nextId: () => {
        throw Error('must not allocate');
      },
    });
    expect(replay.create(createBinding)).toEqual(created);
    expect(replay.set(setBinding)).toEqual(changed);
    expect(replay.set({ ...setBinding, binding: createBinding.binding })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(replay.create({ ...createBinding, name: 'Changed' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
  });

  it('refuses stale versions, unknown metadata, duplicate handles and foreign workspaces', () => {
    const f = bindingFixture();
    f.service.create(createBinding);
    const before = f.store.atomic((tx) => [tx.bot('bot_1'), tx.modelBinding('bot_1')]);
    for (const [input, code] of [
      [{ ...setBinding, expectedProfileVersion: 2 }, 'bot_profile_version_conflict'],
      [{ ...setBinding, botId: 'missing' }, 'unknown_bot'],
      [{ ...setBinding, workspaceId: 'other' }, 'workspace_conflict'],
      [
        { ...setBinding, binding: { connectionId: 'missing', modelId: 'one' } },
        'unknown_connection',
      ],
      [{ ...setBinding, binding: { connectionId: 'shared', modelId: 'missing' } }, 'unknown_model'],
    ] as const)
      expect(f.service.set(input)).toMatchObject({ ok: false, error: { code } });
    expect(f.service.create({ ...createBinding, requestId: 'duplicate' })).toMatchObject({
      ok: false,
      error: { code: 'handle_taken' },
    });
    expect(f.store.atomic((tx) => [tx.bot('bot_1'), tx.modelBinding('bot_1')])).toEqual(before);
    expect(f.store.atomic((tx) => tx.receipt('set'))).toBeNull();
  });

  it('refuses malformed scalar/profile/version inputs without coercion or allocation', () => {
    const f = bindingFixture();
    const invalid = [
      null,
      [],
      {},
      { connectionId: ['shared'], modelId: 'one' },
      { connectionId: 'shared', modelId: 1 },
      { connectionId: 'x'.repeat(257), modelId: 'one' },
      { connectionId: 'shared', modelId: '\ud800' },
    ];
    for (const binding of invalid)
      expect(f.service.create({ ...createBinding, binding: binding as never })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    for (const handle of [null, ['dev'], {}, 1])
      expect(f.service.create({ ...createBinding, handle: handle as never })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    for (const role of [[], 1n, '😀'.repeat(2049)])
      expect(f.service.create({ ...createBinding, role: role as never })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    for (const expectedProfileVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, '1', []])
      expect(
        f.service.set({ ...setBinding, expectedProfileVersion: expectedProfileVersion as never }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.service.create({ ...createBinding, name: 1n as never })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(value(f.service.create(createBinding)).bot.id).toBe('bot_1');
  });

  it('detaches nested inputs before metadata and identity callbacks', () => {
    const f = bindingFixture();
    const input = structuredClone(createBinding);
    const service = new BotModelBindingService({
      store: f.store,
      connections: f.connections,
      factory: {
        catalog: (record) => {
          input.binding.modelId = 'two';
          return f.factory.catalog(record);
        },
      },
      nextId: () => {
        input.binding.connectionId = 'mutated';
        return 'detached';
      },
    });
    const created = value(service.create(input));
    expect(created.binding).toEqual(createBinding.binding);
    Reflect.set(created.binding, 'modelId', 'mutated');
    expect(service.create(createBinding)).toMatchObject({
      ok: true,
      value: { binding: createBinding.binding },
    });
  });

  it('preserves legacy Bot receipts and refuses namespace collisions in both directions', () => {
    const f = bindingFixture();
    const legacy = {
      type: 'CreateBot',
      workspaceId: 'w',
      requestId: 'legacy',
      handle: 'old',
      name: 'Old',
      role: 'Freeform',
      provider: 'deepseek',
      model: 'explicit-legacy',
    } as const;
    const receipt = f.old.execute(legacy);
    expect(receipt).toMatchObject({
      ok: true,
      value: { kind: 'bot', data: { model: 'explicit-legacy' } },
    });
    f.service.set({ ...setBinding, botId: 'bot_1' });
    expect(f.old.execute(legacy)).toEqual(receipt);
    expect(f.service.create({ ...createBinding, requestId: 'legacy' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    f.service.create(createBinding);
    expect(f.old.execute({ ...legacy, requestId: 'create' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    const saved = f.store.atomic((tx) => tx.receipt('legacy'));
    expect(saved?.reply.kind).toBe('bot');
    expect(saved?.reply.data).not.toHaveProperty('binding');
    expect(f.store.atomic((tx) => tx.receipt('create'))?.reply.kind).toBe('bound_bot');
  });

  it('rolls back creation and rebind if receipt insertion fails', () => {
    const f = bindingFixture();
    f.service.create(createBinding);
    const failing: ConversationStore = {
      atomic: (work) =>
        f.store.atomic((tx) =>
          work({
            ...tx,
            putReceipt: () => {
              throw Error('receipt rejected');
            },
          }),
        ),
    };
    const service = new BotModelBindingService({
      store: failing,
      connections: f.connections,
      factory: f.factory,
      nextId: () => 'rolled-back',
    });
    expect(() => service.set(setBinding)).toThrow('receipt rejected');
    expect(() => service.create({ ...createBinding, requestId: 'new', handle: 'new' })).toThrow(
      'receipt rejected',
    );
    expect(f.store.atomic((tx) => tx.bot('rolled-back'))).toBeNull();
    expect(f.store.atomic((tx) => tx.bot('bot_1')?.profileVersion)).toBe(1);
    expect(f.store.atomic((tx) => tx.modelBinding('bot_1'))).toEqual(createBinding.binding);
    expect(f.store.atomic((tx) => tx.receipt('set'))).toBeNull();
  });
  it('projects a changed connection provider while preserving the complete existing profile', () => {
    const f = bindingFixture();
    const before = value(f.service.create(createBinding));
    f.connections.put(
      {
        ...unconfiguredModelConnection('local-fixture'),
        connectionId: 'local',
        kind: 'local',
        auth: 'none',
        endpoint: 'http://127.0.0.1:1234',
        revision: 1,
        intent: 'disconnected',
      },
      null,
    );
    expect(
      f.service.set({ ...setBinding, binding: { connectionId: 'local', modelId: 'two' } }),
    ).toEqual({
      ok: true,
      value: {
        bot: { ...before.bot, provider: 'local-fixture', model: 'two', profileVersion: 2 },
        binding: { connectionId: 'local', modelId: 'two' },
      },
    });
  });

  it('legacy execute refuses even a matching fingerprint from the new receipt family', () => {
    const f = bindingFixture();
    const created = value(f.service.create(createBinding));
    const command = {
      type: 'OpenDirectRoom',
      workspaceId: 'w',
      requestId: 'guard',
      botId: 'bot_1',
    } as const;
    const binding = JSON.stringify(
      Object.entries(command).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    f.store.atomic((tx) =>
      tx.putReceipt('guard', { binding, reply: { kind: 'bound_bot', data: created } }),
    );
    expect(f.old.execute(command)).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
  });
});
