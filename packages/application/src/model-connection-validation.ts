import { readCheckMetadata } from './provider-connection-resolution.js';
import type { ModelConnectionRecord } from './model-connection-ports.js';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !v.includes('\0');
const nullableText = (v: unknown) => v === null || text(v);

/** Every persisted payload is checked before it becomes authority-bearing metadata. */
export function modelConnectionRecord(value: unknown): ModelConnectionRecord {
  if (
    !object(value) ||
    !text(value['connectionId']) ||
    !text(value['providerId']) ||
    (value['connectionId'].startsWith('legacy:') &&
      value['connectionId'] !== `legacy:${value['providerId']}`) ||
    (value['kind'] !== 'cloud' && value['kind'] !== 'local') ||
    (value['auth'] !== 'api_key' && value['auth'] !== 'none') ||
    !nullableText(value['endpoint']) ||
    !nullableText(value['defaultModelId']) ||
    !nullableText(value['secretRef']) ||
    !nullableText(value['requestId']) ||
    !nullableText(value['binding']) ||
    !text(value['updatedAt']) ||
    (value['intent'] !== 'unconfigured' &&
      value['intent'] !== 'active' &&
      value['intent'] !== 'disconnected' &&
      value['intent'] !== 'pending') ||
    typeof value['revision'] !== 'number' ||
    !Number.isSafeInteger(value['revision']) ||
    value['revision'] < 0 ||
    (value['revision'] === 0) !== (value['intent'] === 'unconfigured') ||
    typeof value['legacyEnvironment'] !== 'boolean' ||
    typeof value['configuredAfterRestore'] !== 'boolean' ||
    (value['legacyEnvironment'] &&
      (value['providerId'] !== 'deepseek' ||
        value['connectionId'] !== 'legacy:deepseek' ||
        value['kind'] !== 'cloud' ||
        value['auth'] !== 'api_key')) ||
    (value['intent'] === 'unconfigured' &&
      (value['secretRef'] !== null || value['pendingSecretChange'] !== null)) ||
    (value['lastCheck'] !== null && readCheckMetadata(value['lastCheck']) === null)
  )
    throw Error('connection_unverified');
  const change = value['pendingSecretChange'];
  if (
    change !== null &&
    (!object(change) ||
      (change['action'] !== 'replace' && change['action'] !== 'remove') ||
      !nullableText(change['previousRef']) ||
      !nullableText(change['nextRef']))
  )
    throw Error('connection_unverified');
  // Build a closed typed shape: arbitrary extra JSON never becomes a credential or result field.
  return {
    connectionId: value['connectionId'],
    providerId: value['providerId'],
    kind: value['kind'],
    endpoint: value['endpoint'],
    auth: value['auth'],
    defaultModelId: value['defaultModelId'],
    secretRef: value['secretRef'],
    intent: value['intent'],
    revision: value['revision'],
    requestId: value['requestId'],
    binding: value['binding'],
    lastCheck: readCheckMetadata(value['lastCheck']),
    updatedAt: value['updatedAt'],
    pendingSecretChange:
      change === null
        ? null
        : {
            action: change['action'] as 'replace' | 'remove',
            previousRef: change['previousRef'] as string | null,
            nextRef: change['nextRef'] as string | null,
          },
    legacyEnvironment: value['legacyEnvironment'],
    configuredAfterRestore: value['configuredAfterRestore'],
  };
}
