/**
 * Provider connection truth table.
 *
 * One pure function decides source, state and activation for status, checks and
 * every mutation. Precedence is fixed: a pending intent or unreadable saved
 * secret fails closed (never falls back to the environment), an explicit
 * disconnect blocks the environment, and a restored profile stays inert until
 * the owner configures it again.
 */

import type {
  ProviderCheckMetadata,
  ProviderConnectionIntent,
  ProviderConnectionRecord,
  ProviderConnectionSource,
  ProviderConnectionState,
  ProviderCredential,
  ProviderCredentialPort,
  ProviderSecretRead,
} from './provider-connection-ports.js';

export interface ProviderConnectionResolution {
  readonly source: ProviderConnectionSource;
  readonly state: ProviderConnectionState;
  readonly code: string | null;
  readonly model: string | null;
  readonly credential: ProviderCredential | null;
  readonly savedKey: boolean;
  readonly revision: number;
}
export interface ProviderConnectionInput {
  readonly record: ProviderConnectionRecord | null;
  /** Read of `record.secretRef`, or null when no reference is stored. */
  readonly secret: ProviderSecretRead | null;
  readonly environment: ProviderCredential | null;
  readonly credentials: Pick<ProviderCredentialPort, 'models' | 'own'>;
  readonly restored: boolean;
}
const UNVERIFIED: Omit<ProviderConnectionResolution, 'savedKey' | 'revision'> = {
  source: 'none',
  state: 'unverified',
  code: 'provider_unverified',
  model: null,
  credential: null,
};
/** Selected model must be advertised; never silently switch to another model. */
function selectModel(
  persisted: string | null,
  models: readonly string[],
): { readonly model: string | null; readonly valid: boolean } {
  if (persisted === null) return { model: models[0] ?? null, valid: models.length > 0 };
  return { model: persisted, valid: models.includes(persisted) };
}
function invalidModel(
  source: ProviderConnectionSource,
  model: string | null,
  savedKey: boolean,
  revision: number,
): ProviderConnectionResolution {
  return {
    source,
    state: 'invalid_model',
    code: 'provider_invalid_model',
    model,
    credential: null,
    savedKey,
    revision,
  };
}
function unverified(
  record: ProviderConnectionRecord,
  savedKey: boolean,
): ProviderConnectionResolution {
  return { ...UNVERIFIED, savedKey, revision: record.revision };
}
/** The environment is an external, read-only credential; it is never copied into the store. */
function activate(
  source: 'saved' | 'external',
  credential: ProviderCredential,
  model: string | null,
  record: ProviderConnectionRecord | null,
  savedKey: boolean,
): ProviderConnectionResolution {
  return {
    source,
    state: 'connected',
    code: null,
    model,
    credential,
    savedKey,
    revision: record?.revision ?? 0,
  };
}
export function resolveProviderConnection(
  input: ProviderConnectionInput,
): ProviderConnectionResolution {
  const { record, secret, environment, credentials, restored } = input;
  const models = credentials.models;
  const savedKey = record !== null && record.secretRef !== null;
  const revision = record?.revision ?? 0;
  if (restored)
    return {
      source: 'none',
      state: 'restored',
      code: 'provider_restored',
      model: null,
      credential: null,
      savedKey,
      revision,
    };
  const intent: ProviderConnectionIntent | null = record?.intent ?? null;
  if (record !== null && intent === 'pending')
    // Intent was persisted but activation was never verified: fail closed.
    return unverified(record, savedKey);
  if (record !== null && intent === 'disconnected') {
    // An explicit owner disconnect outranks both a retained saved secret and the environment.
    const selected = selectModel(record.model, models);
    if (!selected.valid) return invalidModel('none', selected.model, savedKey, revision);
    return {
      source: 'none',
      state: 'disconnected',
      code: 'provider_disconnected',
      model: selected.model,
      credential: null,
      savedKey,
      revision,
    };
  }
  if (record !== null && record.secretRef !== null) {
    if (secret === null || secret.status === 'absent') return unverified(record, true);
    if (secret.status === 'unverified')
      return { ...UNVERIFIED, code: secret.reason, savedKey: true, revision };
    const selected = selectModel(record.model, models);
    if (!selected.valid) return invalidModel('saved', selected.model, true, revision);
    try {
      return activate('saved', credentials.own(secret.key), selected.model, record, true);
    } catch {
      // A credential the adapter rejects can never become an activation.
      return unverified(record, true);
    }
  }
  const selected = selectModel(record?.model ?? null, models);
  if (!selected.valid) {
    if (environment === null && record === null)
      return {
        source: 'none',
        state: 'absent',
        code: null,
        model: null,
        credential: null,
        savedKey,
        revision,
      };
    return invalidModel(environment === null ? 'none' : 'external', null, savedKey, revision);
  }
  if (environment !== null)
    return activate('external', environment, selected.model, record, savedKey);
  return {
    source: 'none',
    state: 'absent',
    code: null,
    model: selected.model,
    credential: null,
    savedKey,
    revision,
  };
}
/** Normalize a persisted check row; malformed metadata is dropped, never guessed. */
export function readCheckMetadata(value: unknown): ProviderCheckMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const outcomes = ['ok', 'auth', 'network', 'timeout', 'server', 'unavailable'];
  const sources = ['saved', 'external', 'injected', 'none'];
  if (!outcomes.some((x) => x === v['outcome']) || !sources.some((x) => x === v['source']))
    return null;
  if (
    !(
      v['httpStatus'] === null ||
      (Number.isSafeInteger(v['httpStatus']) && (v['httpStatus'] as number) >= 100)
    ) ||
    !Number.isSafeInteger(v['durationMs']) ||
    (v['durationMs'] as number) < 0 ||
    !Array.isArray(v['models']) ||
    !v['models'].every((m) => typeof m === 'string' && m.length > 0 && m.length <= 256) ||
    typeof v['modelSupported'] !== 'boolean' ||
    !Number.isSafeInteger(v['revision']) ||
    (v['revision'] as number) < 0 ||
    typeof v['checkedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(v['checkedAt']))
  )
    return null;
  return {
    outcome: v['outcome'] as ProviderCheckMetadata['outcome'],
    httpStatus: v['httpStatus'] as number | null,
    durationMs: v['durationMs'] as number,
    models: v['models'] as readonly string[],
    modelSupported: v['modelSupported'],
    source: v['source'] as ProviderCheckMetadata['source'],
    revision: v['revision'] as number,
    checkedAt: v['checkedAt'],
  };
}
