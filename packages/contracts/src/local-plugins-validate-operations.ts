/**
 * Strict validators for the durable plugin operation journal wire contract.
 *
 * Ownership replies only: bounded metadata, a bounded argument copy and a
 * bounded result summary. No credential value and no raw provider payload is
 * accepted or emitted.
 */

import type {
  LocalPluginOperationAcknowledgeRequest,
  LocalPluginOperationListQuery,
  LocalPluginOperationQuery,
  LocalPluginOperationState,
  LocalPluginOperationView,
} from './local-plugins.js';
import { bounded, digest, only, position, record } from './local-plugins-validate-base.js';

const states = new Set<LocalPluginOperationState>([
  'started',
  'observed',
  'failed',
  'not_started',
  'uncertain',
  'acknowledged',
]);

function operationState(value: unknown): value is LocalPluginOperationState {
  return typeof value === 'string' && states.has(value as LocalPluginOperationState);
}

function optionalText(value: unknown, max: number): boolean {
  return value === null || bounded(value, max);
}

const LIST_KEYS = ['workspaceId', 'roomId', 'botId', 'state', 'limit'] as const;

export function isLocalPluginOperationListQuery(
  value: unknown,
): value is LocalPluginOperationListQuery {
  return (
    record(value) &&
    Object.keys(value).every((name) => (LIST_KEYS as readonly string[]).includes(name)) &&
    (value['workspaceId'] === undefined || bounded(value['workspaceId'], 128)) &&
    (value['roomId'] === undefined || bounded(value['roomId'], 128)) &&
    (value['botId'] === undefined || bounded(value['botId'], 128)) &&
    (value['state'] === undefined || operationState(value['state'])) &&
    (value['limit'] === undefined ||
      (position(value['limit']) && Number(value['limit']) >= 1 && Number(value['limit']) <= 200))
  );
}

export function isLocalPluginOperationQuery(value: unknown): value is LocalPluginOperationQuery {
  return record(value) && only(value, ['operationId']) && bounded(value['operationId'], 256);
}

export function isLocalPluginOperationAcknowledgeRequest(
  value: unknown,
): value is LocalPluginOperationAcknowledgeRequest {
  return (
    record(value) &&
    (only(value, ['operationId', 'expectedRevision']) ||
      only(value, ['operationId', 'expectedRevision', 'reason'])) &&
    bounded(value['operationId'], 256) &&
    position(value['expectedRevision']) &&
    Number(value['expectedRevision']) >= 1 &&
    (value['reason'] === undefined || bounded(value['reason'], 512))
  );
}

export function isLocalPluginOperationView(value: unknown): value is LocalPluginOperationView {
  return (
    record(value) &&
    only(value, [
      'id',
      'workspaceId',
      'roomId',
      'botId',
      'pluginId',
      'connectionId',
      'connectionGeneration',
      'endpoint',
      'tool',
      'repository',
      'schemaDigest',
      'argumentsDigest',
      'arguments',
      'state',
      'outcomeCode',
      'detail',
      'resultSummary',
      'resultBytes',
      'truncated',
      'revision',
      'createdAt',
      'settledAt',
      'acknowledgedAt',
      'acknowledgedReason',
    ]) &&
    bounded(value['id'], 256) &&
    bounded(value['workspaceId'], 128) &&
    bounded(value['roomId'], 128) &&
    bounded(value['botId'], 128) &&
    bounded(value['pluginId'], 64) &&
    bounded(value['connectionId'], 128) &&
    position(value['connectionGeneration']) &&
    Number(value['connectionGeneration']) >= 1 &&
    bounded(value['endpoint'], 2048) &&
    bounded(value['tool'], 128) &&
    bounded(value['repository'], 256) &&
    digest(value['schemaDigest']) &&
    digest(value['argumentsDigest']) &&
    bounded(value['arguments'], 4096) &&
    operationState(value['state']) &&
    optionalText(value['outcomeCode'], 64) &&
    optionalText(value['detail'], 512) &&
    optionalText(value['resultSummary'], 8192) &&
    (value['resultBytes'] === null || position(value['resultBytes'])) &&
    typeof value['truncated'] === 'boolean' &&
    position(value['revision']) &&
    Number(value['revision']) >= 1 &&
    bounded(value['createdAt'], 64) &&
    optionalText(value['settledAt'], 64) &&
    optionalText(value['acknowledgedAt'], 64) &&
    optionalText(value['acknowledgedReason'], 512)
  );
}

export function isLocalPluginOperations(
  value: unknown,
): value is readonly LocalPluginOperationView[] {
  return Array.isArray(value) && value.length <= 200 && value.every(isLocalPluginOperationView);
}
