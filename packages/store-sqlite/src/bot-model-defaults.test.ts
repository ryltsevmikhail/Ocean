import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ProviderConnectionService } from '@runnets/application';
import {
  bindingFixture,
  createBinding,
} from '../../application/test-fixtures/bot-model-binding.js';
import {
  fakeCredentials,
  fakeSecrets,
} from '../../application/test-fixtures/provider-connection-fakes.js';
import { openSqliteStore } from './index.js';

it('provider.set changes only the legacy default until one bot is explicitly rebound', () => {
  const db = openSqliteStore({ path: ':memory:' });
  try {
    const f = bindingFixture(db.conversations, db.modelConnections);
    const one = 'deepseek-flash',
      two = 'deepseek-v4-pro';
    f.models([one, two]);
    const provider = new ProviderConnectionService({
      store: db.providerConnections,
      secrets: fakeSecrets(),
      credentials: fakeCredentials(),
      nextId: () => 'a'.repeat(32),
      sha256: (text) => createHash('sha256').update(text).digest('hex'),
      clock: { now: () => new Date(0) },
    });
    provider.set({ requestId: 'default-one', model: one, key: 'synthetic-fixture-key' });
    const first = f.service.create({
      ...createBinding,
      binding: { connectionId: 'legacy:deepseek', modelId: one },
    });
    const second = f.service.create({
      ...createBinding,
      requestId: 'sibling',
      handle: 'review',
      binding: { connectionId: 'legacy:deepseek', modelId: two },
    });
    const legacy = {
      type: 'CreateBot',
      workspaceId: 'w',
      requestId: 'legacy',
      handle: 'old',
      name: 'Old',
      role: 'Explicit model',
      provider: 'deepseek',
      model: one,
    } as const;
    const oldReceipt = f.old.execute(legacy);
    const before = db.conversations.atomic((tx) =>
      tx.bots().map((bot) => ({ bot, binding: tx.modelBinding(bot.id) })),
    );
    expect(provider.set({ requestId: 'default-two', model: two }).model).toBe(two);
    expect(provider.status().model).toBe(two);
    expect(
      db.conversations.atomic((tx) =>
        tx.bots().map((bot) => ({ bot, binding: tx.modelBinding(bot.id) })),
      ),
    ).toEqual(before);
    expect(first).toMatchObject({ ok: true, value: { bot: { model: one } } });
    expect(second).toMatchObject({ ok: true, value: { bot: { model: two } } });
    expect(
      f.service.set({
        workspaceId: 'w',
        requestId: 'rebind',
        botId: 'bot_1',
        expectedProfileVersion: 1,
        binding: { connectionId: 'legacy:deepseek', modelId: two },
      }),
    ).toMatchObject({
      ok: true,
      value: { bot: { model: two, profileVersion: 2 } },
    });
    expect(db.conversations.atomic((tx) => tx.bot('bot_2'))).toEqual(
      before.find((row) => row.bot.id === 'bot_2')?.bot,
    );
    expect(f.old.execute(legacy)).toEqual(oldReceipt);
    expect(db.conversations.atomic((tx) => tx.bot('bot_3')?.model)).toBe(one);
  } finally {
    db.close();
  }
});
