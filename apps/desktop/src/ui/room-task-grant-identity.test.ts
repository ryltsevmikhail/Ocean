import { expect, it, vi } from 'vitest';
import { LOCAL_SERVICE_AUTHORITY, type LocalOwnerScopeGrant } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { commands, type Command } from '../protocol.js';
import { dispatchServiceSettings } from '../host/service-settings-client.js';
import { createRoomTasks } from './room-task-state.js';
const binding = { profileId: 'a'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111' };
const grant: LocalOwnerScopeGrant = {
  id: 'grant',
  policyVersion: 2,
  revision: 1,
  state: 'active',
  owner: { ownerId: 'owner', issuedAt: '2026-01-01T00:00:00Z', source: 'owner-interface' },
  subject: { workspaceId: 'ws_ocean', roomId: 'r', botId: 'bot', projectId: null, taskId: null },
  permissions: [
    {
      kind: 'service',
      connectionId: 'service',
      trustRevision: 1,
      tools: { kind: 'exact', names: ['read'] },
      resources: [{ kind: 'connection', connectionId: 'service' }],
    },
  ],
  mode: 'confirm',
  limits: { maxCalls: 1, maxEffectBytes: 100, expiresAt: null },
  updatedAt: '2026-01-01T00:00:00Z',
};
function setup(identity: typeof binding) {
  const serviceGrants = vi.fn(async () => [grant]);
  const native = {
    identity: { ...identity, capabilities: [LOCAL_SERVICE_AUTHORITY] },
    serviceGrants,
  } as unknown as LocalRuntimeClient;
  const request = vi.fn(async (raw: Command) => {
    const c = commands.parse(raw);
    if (c.op === 'task-support') return { ...binding, supported: true };
    if (c.op === 'task-list') {
      expect(c.binding).toEqual(binding);
      return { workspaceId: 'ws_ocean', roomId: 'r', roots: [], nextBeforeSeq: null };
    }
    if (c.op === 'service-grants') return dispatchServiceSettings(native, c);
    throw Error('unexpected_' + c.op);
  });
  return { state: createRoomTasks(request as never), request, serviceGrants };
}
it.each([
  ['profile', { ...binding, profileId: 'b'.repeat(64) }],
  ['instance', { ...binding, instanceId: '22222222-2222-4222-8222-222222222222' }],
] as const)(
  'refuses a fresh native %s change after the bound empty task index without publishing foreign grants or clearing stale',
  async (_kind, identity) => {
    const { state, request, serviceGrants } = setup(identity);
    await state.context('r');
    expect(serviceGrants).not.toHaveBeenCalled();
    expect(state.binding.value).toEqual(binding);
    expect(state.roots.value).toEqual([]);
    expect(state.grants.value).toEqual([]);
    expect(state.grantsUnavailable.value).toBe(true);
    expect(state.stale.value).toBe(true);
    expect(state.message.value).toContain('task_identity_changed');
    expect(request.mock.calls.map(([c]) => c.op)).toEqual([
      'task-support',
      'task-list',
      'service-grants',
    ]);
    state.close();
  },
);
it('publishes matching-identity grants as fresh after the empty task index with the same captured binding', async () => {
  const { state, request, serviceGrants } = setup(binding);
  await state.context('r');
  expect(request.mock.calls.find(([c]) => c.op === 'service-grants')?.[0]).toEqual({
    op: 'service-grants',
    binding,
  });
  expect(serviceGrants).toHaveBeenCalledOnce();
  expect(state.grants.value).toEqual([grant]);
  expect(state.grantsUnavailable.value).toBe(false);
  expect(state.stale.value).toBe(false);
  state.close();
});
