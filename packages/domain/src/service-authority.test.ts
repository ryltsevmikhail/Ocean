import { describe, expect, it } from 'vitest';
import {
  validEffectResourceScope,
  validOwnerScopeGrant,
  validServiceCatalogSnapshot,
  validServiceConnection,
  validServiceTrustBinding,
  validOwnerGrantReference,
} from './index.js';
import {
  ownerGrant,
  serviceCatalog,
  serviceConnection,
} from '../../../test-fixtures/service-authority.js';

describe('neutral service authority contracts', () => {
  it('accepts HTTP and pinned stdio with secret references only', () => {
    expect(validServiceConnection(serviceConnection)).toBe(true);
    expect(
      validServiceConnection({
        ...serviceConnection,
        configuration: {
          kind: 'stdio',
          executable: '/opt/server',
          sha256: 'b'.repeat(64),
          args: ['--stdio'],
        },
      }),
    ).toBe(true);
    for (const configuration of [
      { kind: 'stdio', executable: '/opt/server', args: [] },
      { kind: 'http', url: 'https://user:password@third.example/mcp' },
      { kind: 'http', url: 'https://host:invalid/mcp' },
      { kind: 'http', url: 'https://third.example/line\nbreak' },
      { kind: 'http', url: 'https://third.example/mcp?token=secret' },
      {
        kind: 'http',
        url: 'https://third.example/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
    ])
      expect(validServiceConnection({ ...serviceConnection, configuration })).toBe(false);
    expect(validServiceConnection({ ...serviceConnection, token: 'secret' })).toBe(false);
    expect(
      validServiceConnection({ ...serviceConnection, credentialReference: 'Bearer secret' }),
    ).toBe(false);
    expect(validServiceConnection({ ...serviceConnection, sessionId: 'session' })).toBe(false);
    expect(
      validServiceConnection({ ...serviceConnection, createdAt: '2026-02-31T00:00:00.000Z' }),
    ).toBe(false);
  });
  it('keeps unverified identity and declared enforcement distinct from evidence', () => {
    expect(validServiceTrustBinding(serviceConnection.trust)).toBe(true);
    expect(
      validServiceTrustBinding({
        ...serviceConnection.trust,
        metadataPermission: { toString: () => 'allow' },
      }),
    ).toBe(false);
    const scope = {
      kind: 'github-repository',
      connectionId: 'third',
      accountId: 'account',
      repository: 'team/api',
    };
    expect(
      validServiceTrustBinding({
        ...serviceConnection.trust,
        resourceEnforcement: [{ status: 'declared', scope }],
      }),
    ).toBe(true);
    expect(
      validServiceTrustBinding({
        ...serviceConnection.trust,
        resourceEnforcement: [{ status: 'evidenced', scope }],
      }),
    ).toBe(false);
    expect(
      validServiceTrustBinding({
        ...serviceConnection.trust,
        resourceEnforcement: [{ status: 'evidenced', scope, evidenceReference: 'proof-1' }],
      }),
    ).toBe(true);
    expect(
      validServiceTrustBinding({
        ...serviceConnection.trust,
        identity: { status: 'verified', accountId: 'a' },
      }),
    ).toBe(false);
  });
  it('requires full bounded complete catalogs without losing schemas or annotations', () => {
    expect(validServiceCatalogSnapshot(serviceCatalog)).toBe(true);
    const tool = serviceCatalog.tools[0]!;
    const { outputSchema: _output, ...partial } = tool;
    expect(validServiceCatalogSnapshot({ ...serviceCatalog, tools: [partial] })).toBe(false);
    expect(validServiceCatalogSnapshot({ ...serviceCatalog, completeness: 'partial' })).toBe(false);
    expect(
      validServiceCatalogSnapshot({
        ...serviceCatalog,
        tools: Array.from({ length: 257 }, (_, i) => ({ ...tool, name: String(i) })),
      }),
    ).toBe(false);
    expect(
      validServiceCatalogSnapshot({
        ...serviceCatalog,
        tools: [{ ...tool, description: 'é'.repeat(3 * 1024 * 1024) }],
      }),
    ).toBe(false);
    expect(validServiceCatalogSnapshot({ ...serviceCatalog, tools: [tool, tool] })).toBe(false);
    expect(
      validServiceCatalogSnapshot({
        ...serviceCatalog,
        tools: [{ ...tool, annotations: { cost: Infinity } }],
      }),
    ).toBe(false);
  });
  it('accepts versioned generic and coding permissions without GitHub fields', () => {
    expect(validOwnerScopeGrant(ownerGrant)).toBe(true);
    expect(
      validOwnerScopeGrant({
        ...ownerGrant,
        mode: 'confirm',
        permissions: [
          {
            kind: 'coding',
            actions: ['project_read', 'propose_write'],
            resources: [{ kind: 'project-worktree', projectId: 'project', worktreeId: 'tree' }],
          },
        ],
      }),
    ).toBe(true);
    expect(validOwnerGrantReference({ grantId: 'grant', revision: 2 })).toBe(true);
    expect(validOwnerGrantReference({ grantId: 'grant', revision: 0 })).toBe(false);
  });
  it('requires explicit future tools and rejects unknown or legacy authority', () => {
    const permission = ownerGrant.permissions[0]!;
    if (permission.kind !== 'service') throw Error('service fixture required');
    const { trustRevision: _trust, ...missingTrust } = permission;
    expect(validOwnerScopeGrant({ ...ownerGrant, permissions: [missingTrust] })).toBe(false);
    expect(
      validOwnerScopeGrant({
        ...ownerGrant,
        permissions: [{ ...permission, trustRevision: undefined }],
      }),
    ).toBe(false);
    for (const tools of [
      { kind: 'current-set', names: ['notes.search'] },
      { kind: 'all-including-future', explicitlySelected: true },
    ])
      expect(validOwnerScopeGrant({ ...ownerGrant, permissions: [{ ...permission, tools }] })).toBe(
        true,
      );
    for (const tools of [
      undefined,
      { kind: 'all-including-future' },
      { kind: 'all-including-future', explicitlySelected: false },
      { kind: 'unknown' },
      { kind: 'exact', names: [] },
    ])
      expect(validOwnerScopeGrant({ ...ownerGrant, permissions: [{ ...permission, tools }] })).toBe(
        false,
      );
    for (const patch of [
      { policyVersion: 1 },
      { revision: 0 },
      { schemaDigest: 'a'.repeat(64) },
      { sdkVersion: '1' },
      { mode: 'bypass' },
      { permissions: [{ kind: 'coding', actions: ['everything'], resources: [] }] },
    ])
      expect(validOwnerScopeGrant({ ...ownerGrant, ...patch })).toBe(false);
  });
  it('treats missing effect scope conservatively, never as an empty resource set', () => {
    expect(validEffectResourceScope(undefined)).toBe(false);
    expect(validEffectResourceScope({ kind: 'resources', resources: [] })).toBe(false);
    expect(validEffectResourceScope({ kind: 'legacy-global-unknown' })).toBe(true);
    expect(
      validEffectResourceScope({
        kind: 'resources',
        resources: [{ kind: 'account', connectionId: 'third', accountId: 'account' }],
      }),
    ).toBe(true);
  });
});
