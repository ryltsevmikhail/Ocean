import { afterEach, expect, it, vi } from 'vitest';
import type { LocalRestoreSelection } from '@runnets/contracts';
import { localRestoreClient } from './local-restore-client.js';
import { localDecisionClient } from './local-decision-client.js';
const input = {
  workspaceId: 'workspace',
  roomId: 'room',
  requestId: 'restore',
  taskId: 'task',
  projectRoot: '/selected',
  policy: {
    version: 1,
    devCapabilities: [],
    reviewCapabilities: ['changeset_read'],
    testPresets: [],
  },
} as const;
const selection: LocalRestoreSelection = {
  ...input,
  profileId: 'a'.repeat(64),
  snapshotId: 'b'.repeat(64),
  sourceOwnerId: 'owner',
  baseCommit: 'c'.repeat(40),
  treeHash: 'd'.repeat(64),
};
const card = {
  workspaceId: input.workspaceId,
  roomId: input.roomId,
  runId: 'restore-run',
  decisionId: 'decision',
  kind: 'restore-rebind',
  version: 1,
  status: 'pending',
  bindingDigest: 'e'.repeat(64),
  createdAt: 1,
  expiresAt: 300001,
  previewLength: 20,
} as const;
afterEach(() => vi.useRealTimers());
it.each(['inspect', 'preview', 'resolve'] as const)(
  'waits for a slow restore %s without retrying the request',
  async (method) => {
    vi.useFakeTimers();
    const response =
      method === 'inspect'
        ? { selection, holds: [], observations: [], postSnapshotInterval: 'unknown-never-replayed' }
        : method === 'preview'
          ? card
          : { ...card, version: 2, status: 'allowed' };
    // Model the real Peer deadline: ordinary requests expire after five seconds.
    const send = vi.fn(
      (_method: string, _input: unknown, timeout = 5000) =>
        new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error('runtime_timeout')), timeout);
          setTimeout(() => {
            clearTimeout(deadline);
            resolve(response);
          }, 6000);
        }),
    );
    const restore = localRestoreClient(send);
    const promise =
      method === 'inspect'
        ? restore.inspectRestore(input)
        : method === 'preview'
          ? restore.previewRestore(selection)
          : localDecisionClient(send).resolveDecision({
              workspaceId: card.workspaceId,
              roomId: card.roomId,
              runId: card.runId,
              decisionId: card.decisionId,
              bindingDigest: card.bindingDigest,
              expectedVersion: 1,
              choice: 'allow-once',
            });
    const settled = promise.then(
      (value) => ({ value }),
      (error) => ({ error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(await settled).toEqual({ value: response });
    expect(send).toHaveBeenCalledTimes(1);
  },
);
it('keeps a finite deadline and never retries a lost restore preview', async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    (_method: string, _input: unknown, timeout = 5000) =>
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(Error('runtime_timeout')), timeout),
      ),
  );
  const result = localRestoreClient(send)
    .previewRestore(selection)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30000);
  expect(await result).toEqual(Error('runtime_timeout'));
  expect(send).toHaveBeenCalledTimes(1);
});
