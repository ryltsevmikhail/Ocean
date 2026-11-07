import { describe, expect, it, vi } from 'vitest';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { desktopEntry } from './desktop-entry.js';
import { dispatchProject, projectCommand } from './project-client.js';

const binding = { profileId: 'profile', instanceId: 'instance' };
const workspaceId = 'ws_ocean';
const scope = { workspaceId, roomId: 'dev', taskId: 'task' };
const submit = { ...scope, requestId: 'once', text: '<script>do not render</script>' };
const task = {
  workspaceId,
  id: 'task',
  ownerRoomId: 'dev',
  devBotId: 'developer',
  reviewRoomId: 'review',
  reviewBotId: 'reviewer',
  policyVersion: 1,
  status: 'reserved',
  worktreeRoot: '/worktree',
};
const envelope = (op: string, input: unknown) => ({ op, input, binding });
function fixture(capabilities = ['coding.workspace-v1']) {
  const client = {
    identity: { ...binding, capabilities },
    codingRead: vi.fn().mockResolvedValue(task),
    submit: vi.fn().mockResolvedValue({ ...scope, requestId: 'once', runId: 'run' }),
    getReceipt: vi.fn().mockResolvedValue(null),
    resolveDecision: vi.fn(),
  };
  const dispatch = (raw: unknown) =>
    dispatchProject(client as unknown as LocalRuntimeClient, projectCommand(raw));
  return { client, dispatch };
}

describe('project desktop boundary', () => {
  it('chooses another page and browser state while keeping the bot profile default and override', () => {
    expect(desktopEntry([], '/desktop')).toEqual({
      page: 'index.html',
      userData: '/desktop',
      profile: '/desktop/conversation/profile',
    });
    expect(desktopEntry(['--projects'], '/desktop')).toEqual({
      page: 'projects.html',
      userData: '/desktop/projects',
      profile: '/desktop/conversation/profile',
    });
    expect(desktopEntry(['--projects'], '/desktop', '/runtime/profile').profile).toBe(
      '/runtime/profile',
    );
  });

  it.each([
    envelope('shell', {}),
    envelope('service-resolve', {}),
    envelope('send', { ...submit, workspaceId: 'other' }),
    envelope('send', { ...submit, to: 'intruder' }),
    envelope('send', { ...submit, lease: 'secret' }),
    envelope('send', { ...submit, taskId: undefined }),
  ])('rejects renderer input outside the project contract', (raw) => {
    expect(() => projectCommand(raw)).toThrow('invalid_request');
  });

  it('targets only the task’s authoritative dev room and assigned bot', async () => {
    const { client, dispatch } = fixture();
    await dispatch(envelope('send', submit));
    expect(client.submit.mock.calls).toEqual([[{ ...submit, to: 'developer' }]]);
    await expect(dispatch(envelope('send', { ...submit, roomId: 'review' }))).rejects.toThrow(
      'coding_denied',
    );
    expect(client.submit.mock.calls).toHaveLength(1);
  });

  it('reattaches by receipt without submitting an unknown effect', async () => {
    const { client, dispatch } = fixture();
    expect(await dispatch(envelope('receipt', { ...scope, requestId: 'once' }))).toBeNull();
    expect(client.getReceipt.mock.calls).toEqual([[{ ...scope, requestId: 'once' }]]);
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('refuses an unsupported runtime or a replaced runtime before a write', async () => {
    const old = fixture([]);
    expect(await old.dispatch({ op: 'support' })).toMatchObject({ supported: false });
    await expect(old.dispatch(envelope('send', submit))).rejects.toThrow(
      'project_runtime_upgrade_required',
    );
    const replaced = fixture();
    await expect(
      replaced.dispatch({
        ...envelope('send', submit),
        binding: { ...binding, instanceId: 'old' },
      }),
    ).rejects.toThrow('project_identity_changed');
    expect(old.client.submit).not.toHaveBeenCalled();
    expect(replaced.client.submit).not.toHaveBeenCalled();
  });
});

it('will not run a project effect to recover a missing card', async () => {
  const getDecision = vi.fn().mockRejectedValue(Error('unknown_decision'));
  const requestCodingReview = vi.fn();
  const client = {
    identity: { ...binding, capabilities: ['coding.workspace-v1'] },
    getDecision,
    requestCodingReview,
  } as unknown as LocalRuntimeClient;
  const command = projectCommand(
    envelope('operation-status', {
      ...scope,
      roomId: 'review',
      requestId: 'old-request',
      operation: 'review',
    }),
  );
  await expect(dispatchProject(client, command)).rejects.toThrow('unknown_decision');
  expect(requestCodingReview).not.toHaveBeenCalled();
});

it('only submits the inspected exact decision once and rejects a foreign task or changed card', async () => {
  const { createHash } = await import('node:crypto');
  const key = { ...scope, roomId: 'review', requestId: 'review-once', operation: 'review' };
  const exact = {
    workspaceId,
    roomId: 'review',
    taskId: 'task',
    requestId: 'review-once',
    hash: 'a'.repeat(64),
  };
  const preview = JSON.stringify({ operation: 'review', request: exact });
  const bindingDigest = createHash('sha256').update(preview).digest('hex');
  const id =
    'coding-review-' +
    createHash('sha256')
      .update(JSON.stringify([workspaceId, 'review-once']))
      .digest('hex');
  const ref = { workspaceId, roomId: 'review', runId: id, decisionId: id };
  const card = {
    ...ref,
    kind: 'project-setup',
    status: 'pending',
    bindingDigest,
    version: 1,
    previewLength: preview.length,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  const getDecision = vi.fn().mockResolvedValue(card);
  const resolveDecision = vi.fn().mockResolvedValue({ ...card, status: 'allowed', version: 2 });
  const client = {
    identity: { ...binding, capabilities: ['coding.workspace-v1'] },
    getDecision,
    decisionPreview: vi.fn().mockResolvedValue(preview),
    resolveDecision,
  } as unknown as LocalRuntimeClient;
  const dispatch = (op: string, input: unknown) =>
    dispatchProject(client, projectCommand(envelope(op, input)));
  await expect(dispatch('operation-card', { ...key, taskId: 'foreign' })).rejects.toThrow(
    'decision_scope_changed',
  );
  await expect(dispatch('operation-card', key)).resolves.toMatchObject({ preview });
  const vote = { choice: 'allow-once', expectedVersion: 1, bindingDigest };
  await expect(
    dispatch('operation-vote', { ...key, ...vote, bindingDigest: 'b'.repeat(64) }),
  ).rejects.toThrow('version_conflict');
  await expect(dispatch('operation-vote', { ...key, ...vote })).resolves.toMatchObject({
    status: 'allowed',
  });
  getDecision.mockResolvedValue({ ...card, version: 2, status: 'allowed' });
  await expect(dispatch('operation-vote', { ...key, ...vote })).rejects.toThrow('version_conflict');
  expect(resolveDecision.mock.calls).toEqual([[{ ...ref, ...vote }]]);
});

it('refuses cancellation or dev decisions without a receipt bound to the chosen task', async () => {
  const { client, dispatch } = fixture();
  client.getReceipt.mockRejectedValue(Error('coding_denied'));
  const q = { ...scope, requestId: 'ordinary' };
  await expect(
    dispatch(envelope('cancel', { ...q, cancelId: 'cancel', expectedVersion: 4 })),
  ).rejects.toThrow('coding_denied');
  await expect(dispatch(envelope('dev-card', { ...q, decisionId: 'decision' }))).rejects.toThrow(
    'coding_denied',
  );
  expect(client.getReceipt.mock.calls).toEqual([[q], [q]]);
  expect(client.resolveDecision).not.toHaveBeenCalled();
});
