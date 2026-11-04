import { expect, it, vi } from 'vitest';
import * as app from './index.js';
import { modelFixture, localSet } from '../test-fixtures/model-connections.js';
import { bindingFixture, createBinding } from '../test-fixtures/bot-model-binding.js';
import { policyFixture } from '../test-fixtures/room-model-policy.js';

it('reads closed metadata and explicit recovery without private or activation effects', () => {
  const f = modelFixture(app.ModelConnectionService);
  f.service.set(localSet('z'));
  f.secrets.writeFailure = Error('disk');
  expect(() => f.service.set({ ...localSet('a'), auth: 'api_key', key: 'synthetic' })).toThrow();
  f.secretCalls.splice(0);
  f.externalCalls.splice(0);
  const activate = vi.spyOn(f.factory, 'activate');
  const reads = new app.ModelConnectionMetadataService({ ...f.options });
  const page = reads.list({ limit: 1 });
  expect(page.items[0]).toMatchObject({
    connectionId: 'a',
    configuration: { intent: 'pending', savedKeyReferencePresent: true },
    recovery: { kind: 'retry_available', pendingRevision: 1, requiresKeyResupply: true },
  });
  expect(page.nextAfter).toBe('a');
  expect(reads.list({ after: 'a' }).items.map((i) => i.connectionId)).toEqual(['z']);
  expect(JSON.stringify(page)).not.toMatch(/synthetic|psec_|secretRef|previousRef|nextRef|binding/);
  expect(f.secretCalls).toEqual([]);
  expect(f.externalCalls).toEqual([]);
  expect(activate).not.toHaveBeenCalled();
  expect(() => reads.list({ limit: 201 })).toThrow('invalid_params');
  expect(() => reads.list({ after: 'é'.repeat(129) })).toThrow('invalid_params');
  expect(() => reads.list({ byteBudget: 50 })).toThrow('projection_too_large');
});

it('returns exact profile and nullable binding in one scoped snapshot', () => {
  const f = bindingFixture();
  const first = f.service.create(createBinding);
  if (!first.ok) throw Error('fixture');
  const reads = new app.BotModelBindingReads(f.store);
  expect(reads.list({ workspaceId: 'w' })).toEqual({
    version: 1,
    workspaceId: 'w',
    roomId: null,
    items: [first.value],
    nextAfter: null,
  });
  expect(() => reads.list({ workspaceId: 'foreign' })).toThrow('workspace_conflict');
  expect(() => reads.list({ workspaceId: 'w', roomId: 'foreign' })).toThrow('unknown_room');
  f.service.set({
    workspaceId: 'w',
    requestId: 'rebind',
    botId: first.value.bot.id,
    expectedProfileVersion: 1,
    binding: { connectionId: 'shared', modelId: 'two' },
  });
  expect(reads.list({ workspaceId: 'w' }).items[0]).toMatchObject({
    bot: { profileVersion: 2, model: 'two' },
    binding: { modelId: 'two' },
  });
});

it('reads actual room policy revision after another owner mutation without connection reads', () => {
  const f = policyFixture();
  f.policy.set(f.input);
  const read = vi.spyOn(f.connections, 'read');
  const service = new app.RoomModelPolicyService({ store: f.store, connections: f.connections });
  expect(service.get({ workspaceId: 'w', roomId: f.room.id })).toEqual({
    ok: true,
    value: {
      version: 1,
      workspaceId: 'w',
      roomId: f.room.id,
      policy: { roomId: f.room.id, revision: 2, cloudTransfer: 'deny' },
    },
  });
  expect(service.get({ workspaceId: 'foreign', roomId: f.room.id })).toMatchObject({
    ok: false,
    error: { code: 'workspace_conflict' },
  });
  expect(read).not.toHaveBeenCalled();
});

it('distinguishes historical intent, explicit repair and current configuration without guessing input', () => {
  const f = modelFixture(app.ModelConnectionService);
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set({ ...localSet('one'), auth: 'api_key', key: 'synthetic' })).toThrow();
  const pending = f.rows.get('one')!;
  const reads = new app.ModelConnectionMetadataService(f.options);
  f.rows.set('one', { ...pending, pendingRequest: null });
  expect(reads.list().items[0]?.recovery).toEqual({
    kind: 'original_input_required',
    pendingRevision: 1,
    requestId: 'set-one',
  });
  f.rows.set('one', { ...pending, pendingRequest: null, pendingSecretChange: null });
  expect(reads.list().items[0]?.recovery).toEqual({
    kind: 'explicit_key_repair_required',
    pendingRevision: 1,
  });
});

it('uses default/max ID keysets with byte truncation and explicit oversized-item refusal', () => {
  const f = modelFixture(app.ModelConnectionService);
  f.service.set(localSet('000'));
  const original = f.rows.get('000')!;
  for (let n = 1; n < 205; n++) {
    const id = String(n).padStart(3, '0');
    f.rows.set(id, { ...original, connectionId: id, requestId: null });
  }
  const reads = new app.ModelConnectionMetadataService(f.options);
  expect(reads.list().items).toHaveLength(50);
  expect(reads.list({ limit: 200 }).items).toHaveLength(200);
  const first = reads.list({ limit: 1 });
  const budget = new TextEncoder().encode(JSON.stringify(first)).length;
  const page = reads.list({ byteBudget: budget });
  expect(page.items.map((i) => i.connectionId)).toEqual(['000']);
  expect(page.nextAfter).toBe('000');
  expect(reads.list({ after: page.nextAfter! }).items[0]?.connectionId).toBe('001');
  expect(() => reads.list({ byteBudget: budget - 1 })).toThrow('projection_too_large');
});

it('validates optional workspace before reading profile metadata and exposes write restrictions', () => {
  const f = modelFixture(app.ModelConnectionService);
  f.service.set(localSet('one'));
  const bound = bindingFixture();
  const list = vi.spyOn(f.store, 'list');
  const reads = new app.ModelConnectionMetadataService({
    ...f.options,
    conversations: bound.store,
    mutationsAllowed: false,
  });
  expect(() => reads.list({ workspaceId: 'other' })).toThrow('workspace_conflict');
  expect(list).not.toHaveBeenCalled();
  expect(reads.list({ workspaceId: 'w' }).items[0]).toMatchObject({
    writable: false,
    restriction: 'restore_restricted',
  });
});

it('filters room membership and returns explicit missing binding metadata', () => {
  const f = policyFixture();
  f.service.create({ ...createBinding, requestId: 'sibling', handle: 'sibling' });
  const reads = new app.BotModelBindingReads(f.store);
  expect(reads.list({ workspaceId: 'w', roomId: f.room.id }).items.map((b) => b.bot.id)).toEqual([
    f.bot.id,
  ]);
  const missing = new app.BotModelBindingReads({
    atomic: (work) => f.store.atomic((tx) => work({ ...tx, modelBinding: () => null })),
  });
  expect(missing.list({ workspaceId: 'w', roomId: f.room.id }).items[0]?.binding).toBeNull();
});

it('detaches validated last-check arrays from the canonical metadata producer', () => {
  const f = modelFixture(app.ModelConnectionService);
  f.service.set(localSet('one'));
  const models = ['fixture-model'];
  const row = {
    ...f.rows.get('one')!,
    lastCheck: {
      connectionId: 'one',
      outcome: 'ok' as const,
      httpStatus: 200,
      durationMs: 0,
      models,
      modelSupported: true,
      source: 'auth_none' as const,
      revision: 1,
      checkedAt: '2026-11-04T00:00:00Z',
    },
  };
  const reads = new app.ModelConnectionMetadataService({
    store: { list: () => [row] },
    factory: f.factory,
  });
  const result = reads.list();
  (result.items[0]!.lastCheck!.models as string[]).push('mutated');
  expect(models).toEqual(['fixture-model']);
});

it('refuses missing or malformed policy on a read instead of synthesizing revision one', () => {
  const f = policyFixture();
  const service = new app.RoomModelPolicyService({
    store: {
      atomic: (work) => f.store.atomic((tx) => work({ ...tx, roomModelPolicy: () => null })),
    },
    connections: f.connections,
  });
  expect(service.get({ workspaceId: 'w', roomId: f.room.id })).toMatchObject({
    ok: false,
    error: { code: 'model_policy_unavailable' },
  });
  expect(f.policy.get({ workspaceId: 'w', roomId: 'absent' })).toMatchObject({
    ok: false,
    error: { code: 'unknown_room' },
  });
});
