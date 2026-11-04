import { expect, it } from 'vitest';
import { isLocalRuntimeIdentity, LOCAL_PLUGIN_SESSION_AUTHORITY } from '@runnets/contracts';
import { isLocalRuntimeIdentity as rc2Accepts } from '../../test-fixtures/rc2-runtime-contract.js';
import { runtimeCapabilities } from './capabilities.js';

it('accepts the repaired owner while the shipped RC2 client refuses during hello', () => {
  const identity = {
    protocol: 1,
    profileId: 'a'.repeat(64),
    instanceId: '11111111-1111-1111-1111-111111111111',
    capabilities: runtimeCapabilities(false),
  };
  expect(identity.capabilities).toContain(LOCAL_PLUGIN_SESSION_AUTHORITY);
  expect(isLocalRuntimeIdentity(identity)).toBe(true);
  expect(rc2Accepts(identity)).toBe(false);
});
