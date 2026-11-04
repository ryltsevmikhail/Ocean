import {
  readCheckMetadata,
  readModelCheck,
  unconfiguredModelConnection,
  type ModelConnectionRecord,
  type ProviderConnectionRecord,
  type ProviderConnectionReceipt,
} from '@runnets/application';

function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('provider_unverified');
  return value;
}
function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
/** Decode migration evidence using the legacy adapter's normalization rules. */
export function legacyProviderRow(row: Record<string, unknown>): ProviderConnectionRecord {
  const intent = row['intent'];
  if (intent !== 'active' && intent !== 'disconnected' && intent !== 'pending')
    throw Error('provider_unverified');
  const revision = row['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    throw Error('provider_unverified');
  let check: unknown = null;
  try {
    check = JSON.parse(String(row['last_check'])) as unknown;
  } catch {
    /* Legacy check garbage was dropped. */
  }
  return {
    provider: text(row['provider']),
    model: optionalText(row['model']),
    secretRef: optionalText(row['secret_ref']),
    intent,
    revision,
    requestId: optionalText(row['request_id']),
    binding: optionalText(row['binding']),
    lastCheck: readCheckMetadata(check),
    updatedAt: text(row['updated_at']),
  };
}
export function canonicalProviderRecord(
  record: ProviderConnectionRecord,
  current: ModelConnectionRecord = unconfiguredModelConnection(record.provider),
): ModelConnectionRecord {
  return {
    ...current,
    defaultModelId: record.model,
    secretRef: record.secretRef,
    intent: record.intent,
    revision: record.revision,
    requestId: record.requestId,
    binding: record.binding,
    lastCheck: readModelCheck(record.lastCheck, current.connectionId),
    updatedAt: record.updatedAt,
  };
}
export function legacyProviderRecord(
  record: ModelConnectionRecord,
): ProviderConnectionRecord | null {
  if (record.intent === 'unconfigured') return null;
  return {
    provider: record.providerId,
    model: record.defaultModelId,
    secretRef: record.secretRef,
    intent: record.intent,
    revision: record.revision,
    requestId: record.requestId,
    binding: record.binding,
    lastCheck: record.lastCheck === null ? null : readCheckMetadata(record.lastCheck),
    updatedAt: record.updatedAt,
  };
}
export function legacyProviderReceipt(value: unknown): ProviderConnectionReceipt {
  try {
    const parsed = JSON.parse(text(value)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw Error('receipt');
    const receipt = parsed as Record<string, unknown>;
    if (typeof receipt['binding'] !== 'string' || typeof receipt['result'] !== 'object')
      throw Error('receipt');
    return { binding: receipt['binding'], result: receipt['result'] } as ProviderConnectionReceipt;
  } catch {
    throw Error('provider_unverified');
  }
}
