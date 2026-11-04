import { expect, it } from 'vitest';
import { sessionRig } from '../test-fixtures/github-session-rig.js';

it('captures credential continuity before the first provisioning await', async () => {
  const r = await sessionRig();
  await r.discover();
  r.grant();
  const before = r.observations.length;
  const discovering = r.discover();
  // The descriptor is synchronous, but the adapter awaits its public port.
  // Changing here must not attach account B to account A's unchanged grants.
  r.env['OCEAN_ACCOUNT_A'] = 'synthetic-account-B';
  await expect(discovering).rejects.toThrow();
  expect(r.observations).toHaveLength(before);
  expect(r.connection()).toMatchObject({ readiness: 'discovery_required', schemaDigest: null });
  expect(r.store.pluginAccess.grants().every((grant) => grant.state === 'revoked')).toBe(true);
  expect(() => r.grant()).toThrow();
  await r.discover();
  r.grant();
  expect((await r.execute()).output).toContain('fixture-account-B');
  expect(r.business().map((entry) => entry.account)).toEqual(['B']);
});
