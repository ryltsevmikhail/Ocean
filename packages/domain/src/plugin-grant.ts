/**
 * Exact plugin access grants.
 *
 * A grant binds one bot in one room to one connection generation, exact tools,
 * one resource constraint (a repository), one discovered schema digest and one
 * policy version. Nothing here is model-facing: the domain only validates a
 * scope an owner-facing service has already composed.
 */

import {
  PLUGIN_MAX_GRANT_TOOLS,
  PLUGIN_OPERATIONS,
  PLUGIN_POLICY_VERSION,
  validPluginId,
  validPluginRepository,
} from './plugin-catalog.js';
import { validPluginSchemaDigest } from './plugin-connection.js';

export { PLUGIN_MAX_GRANT_TOOLS, PLUGIN_POLICY_VERSION };

/** Tools a grant may name: exactly the shipped read operations, nothing else. */
const GRANTABLE_TOOLS = new Set(PLUGIN_OPERATIONS.map((operation) => operation.tool));

export interface PluginGrantScope {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  /** Exact wire tool names, unique, at most `PLUGIN_MAX_GRANT_TOOLS`. */
  readonly tools: readonly string[];
  /** Resource constraint: one repository `owner/name`. */
  readonly repository: string;
  readonly schemaDigest: string;
  readonly policyVersion: number;
}

export type PluginGrantState = 'active' | 'revoked';

export interface PluginGrantRecord extends PluginGrantScope {
  readonly id: string;
  /** Owner-visible group/personal visibility explanation recorded at grant time. */
  readonly visibility: string;
  readonly state: PluginGrantState;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

const identifier = (value: unknown, max = 128): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

/** A scope is valid only when every authority-bearing field is exact and bounded. */
export function validPluginGrantScope(value: unknown): value is PluginGrantScope {
  if (value === null || typeof value !== 'object') return false;
  const scope = value as Readonly<Record<string, unknown>>;
  const tools = scope['tools'];
  return (
    identifier(scope['workspaceId']) &&
    identifier(scope['roomId']) &&
    identifier(scope['botId']) &&
    validPluginId(scope['pluginId']) &&
    identifier(scope['connectionId']) &&
    Number.isSafeInteger(scope['connectionGeneration']) &&
    Number(scope['connectionGeneration']) >= 1 &&
    Array.isArray(tools) &&
    tools.length >= 1 &&
    tools.length <= PLUGIN_MAX_GRANT_TOOLS &&
    new Set(tools).size === tools.length &&
    tools.every((tool) => typeof tool === 'string' && GRANTABLE_TOOLS.has(tool)) &&
    validPluginRepository(scope['repository']) &&
    validPluginSchemaDigest(scope['schemaDigest']) &&
    scope['policyVersion'] === PLUGIN_POLICY_VERSION
  );
}
