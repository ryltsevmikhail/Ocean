import { expect, it } from 'vitest';
import {
  LOCAL_MODEL_CONNECTIONS,
  LOCAL_PLUGIN_SESSION_AUTHORITY,
  LOCAL_ADDRESSED_HISTORY,
  isLocalRuntimeIdentity,
} from '@runnets/contracts';
import { runtimeCapabilities } from './capabilities.js';
import { clientIdentity } from './client-compatibility.js';
import { isLocalRuntimeIdentity as rc2 } from '../../test-fixtures/rc2-runtime-contract.js';
const identity = {
  protocol: 1 as const,
  profileId: 'a'.repeat(64),
  instanceId: 'a'.repeat(36),
  capabilities: runtimeCapabilities(false),
};
it('projects independent RC2/A3/model capability identities without shared negotiation state', () => {
  expect(identity.capabilities).toHaveLength(79);
  for (let i = 0; i < 3; i++) {
    const a3 = clientIdentity(identity, true, false);
    expect(a3.capabilities).toHaveLength(65);
    expect(a3.capabilities).toContain(LOCAL_PLUGIN_SESSION_AUTHORITY);
    expect(a3.capabilities).not.toContain(LOCAL_MODEL_CONNECTIONS);
    expect(a3.capabilities).not.toContain(LOCAL_ADDRESSED_HISTORY);
    const old = clientIdentity(identity, false, false);
    expect(rc2(old)).toBe(true);
    expect(old.capabilities).toHaveLength(45);
    expect(old.capabilities).not.toContain(LOCAL_ADDRESSED_HISTORY);
    expect(clientIdentity(identity, true, true, true, true).capabilities).not.toContain(
      LOCAL_ADDRESSED_HISTORY,
    );
    const current = clientIdentity(identity, true, true, true, true, true);
    expect(current.capabilities).toContain('service.authority-v2');
    expect(isLocalRuntimeIdentity(current)).toBe(true);
    expect(current.capabilities).toContain(LOCAL_MODEL_CONNECTIONS);
    expect(current.capabilities).toContain(LOCAL_ADDRESSED_HISTORY);
  }
});
