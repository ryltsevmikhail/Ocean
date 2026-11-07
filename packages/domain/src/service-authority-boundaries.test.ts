import { describe, expect, it } from 'vitest';
import {
  validEffectResourceScope,
  validOwnerResources,
  validOwnerScopeGrant,
  validOwnerToolPolicy,
  validServiceCatalogSnapshot,
  validServiceConnection,
  validServiceJson,
  validServiceTrustBinding,
} from './index.js';
import {
  ownerGrant,
  serviceCatalog,
  serviceConnection,
} from '../../../test-fixtures/service-authority.js';

const hole = () => Array<unknown>(1);
describe('authority input boundaries', () => {
  it('rejects sparse resource scopes instead of treating holes as an empty set', () => {
    expect(validOwnerResources(hole())).toBe(false);
    expect(validEffectResourceScope({ kind: 'resources', resources: hole() })).toBe(false);
    const scope = { kind: 'resources', resources: [{ kind: 'connection', connectionId: 'third' }] };
    expect(validEffectResourceScope(scope)).toBe(true);
    expect(validEffectResourceScope(JSON.parse(JSON.stringify(scope)))).toBe(true);
  });
  it('checks every own index of grant permissions, resources, names and coding actions', () => {
    expect(validOwnerScopeGrant({ ...ownerGrant, permissions: hole() })).toBe(false);
    const service = ownerGrant.permissions[0]!;
    for (const patch of [{ resources: hole() }, { tools: { kind: 'exact', names: hole() } }])
      expect(validOwnerScopeGrant({ ...ownerGrant, permissions: [{ ...service, ...patch }] })).toBe(
        false,
      );
    expect(validOwnerToolPolicy({ kind: 'current-set', names: hole() })).toBe(false);
    expect(
      validOwnerScopeGrant({
        ...ownerGrant,
        permissions: [
          {
            kind: 'coding',
            actions: hole(),
            resources: [{ kind: 'project-worktree', projectId: 'p', worktreeId: null }],
          },
        ],
      }),
    ).toBe(false);
    const inherited = Array<unknown>(1);
    const prototype: unknown[] = [];
    Object.defineProperty(prototype, '0', { value: { kind: 'connection', connectionId: 'third' } });
    Object.setPrototypeOf(inherited, prototype);
    expect(validOwnerResources(inherited)).toBe(false);
  });
  it('rejects sparse definitions, trust declarations and nested JSON arrays', () => {
    expect(validServiceCatalogSnapshot({ ...serviceCatalog, tools: hole() })).toBe(false);
    expect(
      validServiceTrustBinding({ ...serviceConnection.trust, resourceEnforcement: hole() }),
    ).toBe(false);
    expect(validServiceJson(hole())).toBe(false);
    expect(validServiceJson({ nested: [hole()] })).toBe(false);
    const tool = serviceCatalog.tools[0]!;
    for (const field of ['inputSchema', 'outputSchema', 'annotations'])
      expect(
        validServiceCatalogSnapshot({
          ...serviceCatalog,
          tools: [{ ...tool, [field]: { nested: hole() } }],
        }),
      ).toBe(false);
    expect(validOwnerScopeGrant(JSON.parse(JSON.stringify(ownerGrant)))).toBe(true);
    expect(validServiceCatalogSnapshot(JSON.parse(JSON.stringify(serviceCatalog)))).toBe(true);
  });
  it('accepts only empty inert stdio arguments and distinguishable environment handles', () => {
    const configuration = {
      kind: 'stdio',
      executable: '/opt/server',
      sha256: 'a'.repeat(64),
      args: [],
    };
    expect(
      validServiceConnection({
        ...serviceConnection,
        configuration,
        credentialReference: 'env:SERVICE_TOKEN',
      }),
    ).toBe(true);
    for (const args of [
      hole(),
      ['--stdio'],
      ['--access-token', 'ghp_ExampleOnlyNotARealCredential'],
    ])
      expect(
        validServiceConnection({ ...serviceConnection, configuration: { ...configuration, args } }),
      ).toBe(false);
    for (const credentialReference of [
      'ghp_ExampleOnlyNotARealCredential',
      'SERVICE_TOKEN',
      'secret:third-work',
      'env:lowercase',
      'env:',
      'env:NAME WITH SPACE',
    ])
      expect(validServiceConnection({ ...serviceConnection, credentialReference })).toBe(false);
    expect(
      validServiceConnection({ ...serviceConnection, credentialReference: 'env:_SERVICE_2' }),
    ).toBe(true);
    expect(validServiceConnection({ ...serviceConnection, credentialReference: null })).toBe(true);
  });
});
