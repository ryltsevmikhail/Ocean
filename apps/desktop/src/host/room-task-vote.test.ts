import { expect, it, vi } from 'vitest';
import { LOCAL_SERVICE_AUTHORITY, LOCAL_SERVICE_CONFIRMATIONS } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { dispatchServiceSettings } from './service-settings-client.js';
const binding = { profileId: 'a'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111' };
const ref = { workspaceId: 'ws_ocean', roomId: 'room', runId: 'run', decisionId: 'decision' };
const input = {
  ...ref,
  expectedVersion: 1,
  bindingDigest: 'b'.repeat(64),
  choice: 'allow-once' as const,
};
const pending = {
  ...ref,
  kind: 'service-call',
  version: 1,
  bindingDigest: input.bindingDigest,
  status: 'pending',
};
function fixture(card: object) {
  const getDecision = vi.fn(async () => card),
    resolveDecision = vi.fn(async () => ({ ...pending, status: 'allowed', version: 2 }));
  const client = {
    identity: { ...binding, capabilities: [LOCAL_SERVICE_AUTHORITY, LOCAL_SERVICE_CONFIRMATIONS] },
    getDecision,
    resolveDecision,
  } as unknown as LocalRuntimeClient;
  return { client, getDecision, resolveDecision };
}
it.each([
  [{ ...pending, status: 'allowed', version: 2 }, 'version_conflict'],
  [{ ...pending, status: 'denied' }, 'version_conflict'],
  [{ ...pending, version: 3 }, 'version_conflict'],
  [{ ...pending, bindingDigest: 'c'.repeat(64) }, 'binding_conflict'],
  [{ ...pending, roomId: 'foreign' }, 'invalid_frame'],
  [{ ...pending, runId: 'foreign' }, 'invalid_frame'],
  [{ ...pending, decisionId: 'foreign' }, 'invalid_frame'],
  [{ ...pending, workspaceId: 'foreign' }, 'invalid_frame'],
] as const)(
  'refuses a stale/foreign task vote after one exact read without resolve: %j',
  async (card, error) => {
    const f = fixture(card);
    await expect(
      dispatchServiceSettings(f.client, { op: 'service-resolve', binding, input }),
    ).rejects.toThrow(error);
    expect(f.getDecision).toHaveBeenCalledExactlyOnceWith(ref);
    expect(f.resolveDecision).not.toHaveBeenCalled();
  },
);
it('passes a still-pending exact vote once to the same authenticated SDK connection', async () => {
  const f = fixture(pending);
  await expect(
    dispatchServiceSettings(f.client, { op: 'service-resolve', binding, input }),
  ).resolves.toMatchObject({ status: 'allowed', version: 2 });
  expect(f.getDecision).toHaveBeenCalledExactlyOnceWith(ref);
  expect(f.resolveDecision).toHaveBeenCalledExactlyOnceWith(input);
});
it('preserves the existing C terminal-card replay for an unbound service-settings command', async () => {
  const f = fixture({ ...pending, version: 2, status: 'allowed' });
  await expect(
    dispatchServiceSettings(f.client, { op: 'service-resolve', input }),
  ).resolves.toMatchObject({ status: 'allowed' });
  expect(f.getDecision).not.toHaveBeenCalled();
  expect(f.resolveDecision).toHaveBeenCalledExactlyOnceWith(input);
});
it('does not resolve after an unknown read outcome', async () => {
  const f = fixture(pending);
  f.getDecision.mockRejectedValueOnce(Error('connection_closed'));
  await expect(
    dispatchServiceSettings(f.client, { op: 'service-resolve', binding, input }),
  ).rejects.toThrow('connection_closed');
  expect(f.resolveDecision).not.toHaveBeenCalled();
});
