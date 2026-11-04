import { expect, it } from 'vitest';
import { isLocalRuntimeIdentity, LOCAL_PLUGIN_SESSION_AUTHORITY } from '@runnets/contracts';
import { isLocalRuntimeIdentity as rc2Accepts } from '../../test-fixtures/rc2-runtime-contract.js';
import { clientIdentity } from './client-compatibility.js';
import { runtimeCapabilities } from './capabilities.js';

it('keeps full current identity distinct from the negotiated RC2 identity', () => {
  const identity = {
    protocol: 1 as const,
    profileId: 'a'.repeat(64),
    instanceId: '11111111-1111-1111-1111-111111111111',
    capabilities: runtimeCapabilities(false),
  };
  expect(identity.capabilities).toContain(LOCAL_PLUGIN_SESSION_AUTHORITY);
  expect(isLocalRuntimeIdentity(identity)).toBe(true);
  expect(rc2Accepts(identity)).toBe(false);
  const legacy = clientIdentity(identity, false);
  expect(rc2Accepts(legacy)).toBe(true);
  expect(legacy.capabilities.some((c) => c.startsWith('plugin.'))).toBe(false);
  expect(clientIdentity(identity, true)).toEqual(identity);
});
