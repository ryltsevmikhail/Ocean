import { expect, it } from 'vitest';
import type { LocalOwnerScopeGrant } from '@runnets/contracts';
import { taskDraft } from './room-task-form.js';
const permission = {
  kind: 'service',
  connectionId: 'c',
  trustRevision: 2,
  tools: { kind: 'exact', names: ['read'] },
  resources: [{ kind: 'connection', connectionId: 'c' }],
} as const;
const grant: LocalOwnerScopeGrant = {
  id: 'g',
  revision: 3,
  policyVersion: 2,
  state: 'active',
  owner: { ownerId: 'owner', issuedAt: '2026-01-01T00:00:00Z', source: 'owner-interface' },
  subject: { workspaceId: 'ws_ocean', roomId: 'r', botId: 'a', projectId: null, taskId: null },
  permissions: [permission],
  mode: 'confirm',
  limits: { maxCalls: 2, maxEffectBytes: 30, expiresAt: null },
  updatedAt: '2026-01-01T00:00:00Z',
};
it('builds a text-only conversation or exact service records, never merges or widens tools or scopes', () => {
  expect(taskDraft('r', ['a', 'b'], 'hello', ['a', 'b'], ['a'], [], [])).toEqual({
    text: 'hello',
    participants: [
      { botId: 'a', grantReferences: [] },
      { botId: 'b', grantReferences: [] },
    ],
    initialBotIds: ['a'],
    mandate: { projectId: null, codingTaskId: null, permissions: [] },
  });
  const d = taskDraft('r', ['a'], 'hello', ['a'], ['a'], [grant], ['g@3']);
  expect(d?.participants[0]?.grantReferences).toEqual([{ grantId: 'g', revision: 3 }]);
  expect(d?.mandate.permissions).toEqual([permission]);
  expect(d).not.toHaveProperty('attachments');
});
it('rejects byte overflow, empty initial set, foreign membership, stale/expired/project/coding selections', () => {
  const build = (gs: readonly LocalOwnerScopeGrant[], selected = ['g@3']) =>
    taskDraft('r', ['a'], 'hello', ['a'], ['a'], gs, selected);
  for (const change of [
    { revision: 4 },
    { state: 'revoked' },
    { subject: { ...grant.subject, roomId: 'other' } },
    { subject: { ...grant.subject, projectId: 'p' } },
    { permissions: [{ kind: 'coding', actions: ['commit'], resources: [] }] },
    { limits: { ...grant.limits, expiresAt: '2020-01-01T00:00:00Z' } },
  ])
    expect(build([{ ...grant, ...change } as LocalOwnerScopeGrant])).toBeNull();
  expect(taskDraft('r', ['a'], '😀'.repeat(4097), ['a'], ['a'], [], [])).toBeNull();
  expect(taskDraft('r', ['a'], 'hello', ['a'], [], [], [])).toBeNull();
  expect(taskDraft('r', ['a'], 'hello', ['b'], ['b'], [], [])).toBeNull();
});
