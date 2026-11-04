/**
 * Desktop plugin settings contract.
 *
 * Catalog, named connection references and exact grants cross the IPC boundary
 * as metadata only: a connection exposes the environment variable NAME, never a
 * credential value, and no grant can be composed without an owner action.
 */

import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/);
const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const installState = z.enum(['installing', 'installed', 'interrupted', 'corrupt']);
const connectionName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const credentialReference = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const generation = z.int().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/);
const repository = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9._-]{1,100}$/);
const operationState = z.enum([
  'started',
  'observed',
  'failed',
  'not_started',
  'uncertain',
  'acknowledged',
]);

export const pluginCommands = [
  z.strictObject({ op: z.literal('plugin-catalog'), search: z.string().max(128).optional() }),
  z.strictObject({ op: z.literal('plugin-inspect'), pluginId }),
  z.strictObject({ op: z.literal('plugin-install'), pluginId, version: version.optional() }),
  z.strictObject({ op: z.literal('plugin-repair'), pluginId, version: version.optional() }),
  z.strictObject({ op: z.literal('plugin-enable'), pluginId, version: version.optional() }),
  z.strictObject({ op: z.literal('plugin-disable'), pluginId }),
  z.strictObject({ op: z.literal('plugin-connections') }),
  z.strictObject({
    op: z.literal('plugin-connection-add'),
    name: connectionName,
    pluginId,
    credentialReference,
    accountLabel: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({ op: z.literal('plugin-connection-preview'), connectionId: id }),
  z.strictObject({
    op: z.literal('plugin-connection-consent'),
    connectionId: id,
    expectedGeneration: generation,
  }),
  z.strictObject({
    op: z.literal('plugin-connection-discover'),
    connectionId: id,
    expectedGeneration: generation,
  }),
  z.strictObject({ op: z.literal('plugin-connection-disconnect'), connectionId: id }),
  z.strictObject({ op: z.literal('plugin-access-list'), room: id.optional(), bot: id.optional() }),
  z.strictObject({
    op: z.literal('plugin-access-preview'),
    room: id,
    connectionId: id,
    botId: id,
    repository,
    tools: z.array(z.string().min(1).max(128)).min(1).max(16),
    acknowledgeGroupVisibility: z.boolean(),
  }),
  z.strictObject({
    op: z.literal('plugin-access-grant'),
    room: id,
    connectionId: id,
    botId: id,
    repository,
    tools: z.array(z.string().min(1).max(128)).min(1).max(16),
    acknowledgeGroupVisibility: z.boolean(),
  }),
  z.strictObject({ op: z.literal('plugin-access-revoke'), grantId: id }),
  z.strictObject({
    op: z.literal('plugin-operations-list'),
    room: id.optional(),
    state: operationState.optional(),
  }),
  z.strictObject({ op: z.literal('plugin-operation-show'), operationId: id }),
  z.strictObject({
    op: z.literal('plugin-operation-acknowledge'),
    operationId: id,
    expectedRevision: z.int().min(1),
    reason: z.string().max(512).optional(),
  }),
];

export const pluginInstalled = z
  .object({
    pluginId,
    version,
    state: installState,
    enabled: z.boolean(),
    verified: z.boolean(),
    manifestDigest: digest,
    adapter: z.string().min(1).max(128),
    installedAt: z.string().max(64),
    verifiedAt: z.string().max(64).nullable(),
  })
  .strict();
export const pluginCatalogView = z
  .object({
    pluginId,
    publisher: z.string().min(1).max(128),
    version,
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    transport: z.string().min(1).max(64),
    endpoint: z.string().min(1).max(2048),
    authentication: z.string().min(1).max(64),
    resourceConstraint: z.string().min(1).max(64),
    readOnly: z.boolean(),
    tools: z.array(z.string().min(1).max(128)).max(64),
    operations: z.array(z.string().min(1).max(128)).max(64),
    manifestDigest: digest,
    adapter: z.string().min(1).max(128),
    installed: z.boolean(),
    enabled: z.boolean(),
    installState: installState.nullable(),
    fileVerified: z.boolean(),
  })
  .strict();
export const pluginConnectionView = z
  .object({
    id,
    name: connectionName,
    pluginId,
    pluginVersion: version,
    adapterVersion: z.string().min(1).max(128),
    endpoint: z.string().min(1).max(2048),
    credentialReference,
    accountLabel: z.string().max(256).nullable(),
    identity: z.string().max(256).nullable(),
    identityLabel: z.enum(['verified', 'unverified']),
    state: z.enum(['active', 'disconnected']),
    generation,
    schemaDigest: digest.nullable(),
    tools: z.array(z.string().min(1).max(128)).max(256),
    consented: z.boolean(),
    consentedGeneration: generation.nullable(),
    consentedAt: z.string().max(64).nullable(),
    lastDiscoveryAt: z.string().max(64).nullable(),
    readiness: z.enum(['ready', 'discovery_required', 'disconnected']),
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
  })
  .strict();
export const pluginConsentPreview = z
  .object({
    connectionId: id,
    name: connectionName,
    pluginId,
    endpoint: z.string().min(1).max(2048),
    generation,
    consented: z.boolean(),
    prompt: z.string().min(1).max(4096),
  })
  .strict();
export const pluginDiscoveryResult = z
  .object({
    connection: pluginConnectionView,
    revokedGrants: z.int().nonnegative(),
    authorityChanged: z.boolean(),
  })
  .strict();
export const pluginDisconnectResult = z
  .object({ connection: pluginConnectionView, revokedGrants: z.int().nonnegative() })
  .strict();
export const pluginGrantView = z
  .object({
    id,
    workspaceId: z.string().min(1).max(128),
    roomId: id,
    botId: id,
    pluginId,
    connectionId: id,
    connectionGeneration: generation,
    tools: z.array(z.string().min(1).max(128)).max(16),
    repository: z.string().min(1).max(256),
    schemaDigest: digest,
    policyVersion: z.int().nonnegative(),
    visibility: z.string().min(1).max(4096),
    state: z.enum(['active', 'revoked']),
    createdAt: z.string().max(64),
    revokedAt: z.string().max(64).nullable(),
  })
  .strict();
const grantScope = z
  .object({
    workspaceId: z.string().min(1).max(128),
    roomId: id,
    botId: id,
    pluginId,
    connectionId: id,
    connectionGeneration: generation,
    tools: z.array(z.string().min(1).max(128)).max(16),
    repository: z.string().min(1).max(256),
    schemaDigest: digest,
    policyVersion: z.int().nonnegative(),
  })
  .strict();
export const pluginGrantPreview = z
  .object({
    allowed: z.boolean(),
    refusal: z.string().max(64).nullable(),
    explanation: z.string().min(1).max(4096),
    groupVisibility: z.boolean(),
    participants: z.int().nonnegative(),
    scope: grantScope.nullable(),
  })
  .strict();
export const pluginEnableResult = z
  .object({ installed: pluginInstalled, revokedGrants: z.int().nonnegative() })
  .strict();

export const pluginOperationView = z
  .object({
    id,
    workspaceId: z.string().min(1).max(128),
    roomId: id,
    botId: id,
    pluginId,
    connectionId: id,
    connectionGeneration: generation,
    endpoint: z.string().min(1).max(2048),
    tool: z.string().min(1).max(128),
    repository: z.string().min(1).max(256),
    schemaDigest: digest,
    argumentsDigest: digest,
    arguments: z.string().max(4096),
    state: operationState,
    outcomeCode: z.string().max(64).nullable(),
    detail: z.string().max(512).nullable(),
    resultSummary: z.string().max(8192).nullable(),
    resultBytes: z.int().nonnegative().nullable(),
    truncated: z.boolean(),
    revision: z.int().min(1),
    createdAt: z.string().max(64),
    settledAt: z.string().max(64).nullable(),
    acknowledgedAt: z.string().max(64).nullable(),
    acknowledgedReason: z.string().max(512).nullable(),
  })
  .strict();

export const pluginOutputs = {
  'plugin-catalog': z.array(pluginCatalogView).max(64),
  'plugin-inspect': pluginCatalogView,
  'plugin-install': pluginInstalled,
  'plugin-repair': pluginInstalled,
  'plugin-enable': pluginEnableResult,
  'plugin-disable': pluginInstalled,
  'plugin-connections': z.array(pluginConnectionView).max(32),
  'plugin-connection-add': pluginConnectionView,
  'plugin-connection-preview': pluginConsentPreview,
  'plugin-connection-consent': pluginConsentPreview,
  'plugin-connection-discover': pluginDiscoveryResult,
  'plugin-connection-disconnect': pluginDisconnectResult,
  'plugin-access-list': z.array(pluginGrantView).max(200),
  'plugin-access-preview': pluginGrantPreview,
  'plugin-access-grant': pluginGrantView,
  'plugin-access-revoke': pluginGrantView,
  'plugin-operations-list': z.array(pluginOperationView).max(200),
  'plugin-operation-show': pluginOperationView,
  'plugin-operation-acknowledge': pluginOperationView,
} as const;

export type PluginCatalogView = z.infer<typeof pluginCatalogView>;
export type PluginConnectionView = z.infer<typeof pluginConnectionView>;
export type PluginGrantView = z.infer<typeof pluginGrantView>;
export type PluginGrantPreview = z.infer<typeof pluginGrantPreview>;
export type PluginConsentPreview = z.infer<typeof pluginConsentPreview>;
export type PluginDiscoveryResult = z.infer<typeof pluginDiscoveryResult>;
export type PluginOutputs = typeof pluginOutputs;
export type PluginOperationView = z.infer<typeof pluginOperationView>;
