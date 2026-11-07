import { expect, it, vi } from 'vitest';
import { LOCAL_SERVICE_AUTHORITY } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { dispatchServiceSettings } from './service-settings-client.js';
const binding = { profileId: 'a'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111' };
function client(identity = binding) {
  const serviceGrants = vi.fn(async () => []);
  return {
    sdk: {
      identity: { ...identity, capabilities: [LOCAL_SERVICE_AUTHORITY] },
      serviceGrants,
    } as unknown as LocalRuntimeClient,
    serviceGrants,
  };
}
it.each([
  { ...binding, profileId: 'b'.repeat(64) },
  { ...binding, instanceId: '22222222-2222-4222-8222-222222222222' },
])(
  'rejects a bound service-grant read before SDK dispatch when fresh identity differs: %j',
  (identity) => {
    const { sdk, serviceGrants } = client(identity);
    expect(() => dispatchServiceSettings(sdk, { op: 'service-grants', binding })).toThrow(
      'task_identity_changed',
    );
    expect(serviceGrants).not.toHaveBeenCalled();
  },
);
it('preserves matching bound reads and legacy unbound service-settings reads', async () => {
  const { sdk, serviceGrants } = client();
  await expect(dispatchServiceSettings(sdk, { op: 'service-grants', binding })).resolves.toEqual(
    [],
  );
  await expect(dispatchServiceSettings(sdk, { op: 'service-grants' })).resolves.toEqual([]);
  expect(serviceGrants).toHaveBeenCalledTimes(2);
});
