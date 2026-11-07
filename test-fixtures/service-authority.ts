import type { OwnerScopeGrant, ServiceCatalogSnapshot, ServiceConnection } from '@runnets/domain';
export const authorityAt = '2026-11-05T00:00:00.000Z';
export const authorityVersions = { configRevision: 1, trustRevision: 1, credentialRevision: 1 };
export const serviceConnection: ServiceConnection = {
  id: 'third',
  name: 'Third server',
  ...authorityVersions,
  configuration: { kind: 'http', url: 'https://third.example/mcp' },
  credentialReference: 'env:SERVICE_TOKEN',
  trust: {
    ownerId: 'owner',
    metadataPermission: 'allow',
    identity: { status: 'unverified', label: null },
    resourceEnforcement: [],
  },
  state: 'active',
  currentCatalogId: null,
  createdAt: authorityAt,
  updatedAt: authorityAt,
};
export const serviceCatalog: ServiceCatalogSnapshot = {
  id: 'catalog',
  connectionId: 'third',
  ...authorityVersions,
  completeness: 'complete',
  observedAt: authorityAt,
  provenance: { protocol: 'mcp', adapter: 'test' },
  tools: [
    {
      name: 'notes.search',
      description: 'Search notes',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'array' },
      annotations: { readOnlyHint: true },
      definitionDigest: 'a'.repeat(64),
      provenance: { source: 'third' },
    },
  ],
};
export const ownerGrant: OwnerScopeGrant = {
  id: 'grant',
  policyVersion: 2,
  revision: 1,
  state: 'active',
  owner: { ownerId: 'owner', issuedAt: authorityAt, source: 'owner-interface' },
  subject: { workspaceId: 'ws', roomId: 'room', botId: 'bot', projectId: null, taskId: null },
  permissions: [
    {
      kind: 'service',
      connectionId: 'third',
      trustRevision: 1,
      tools: { kind: 'exact', names: ['notes.search'] },
      resources: [{ kind: 'connection', connectionId: 'third' }],
    },
  ],
  mode: 'autonomous',
  limits: { maxCalls: 10, maxEffectBytes: 4096, expiresAt: null },
  updatedAt: authorityAt,
};
