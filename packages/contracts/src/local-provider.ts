/**
 * Local-runtime provider settings contract.
 *
 * Owner requests may carry a key through authenticated private IPC. Responses
 * carry metadata only and never contain a key or a key fragment.
 */

import { localRuntimeRecord } from './local-runtime.js';

export const LOCAL_PROVIDER_METHODS = [
  'provider.status',
  'provider.check',
  'provider.set',
  'provider.disconnect',
  'provider.removeSavedKey',
] as const;
/** Reads a restore-mode maintenance host can still serve; mutations stay refused there. */
export const LOCAL_PROVIDER_READ_METHODS = ['provider.status'] as const;

export const LOCAL_PROVIDER_KEY_MAX = 512;
export const LOCAL_PROVIDER_MODEL_MAX = 256;
export const LOCAL_PROVIDER_MODELS_MAX = 200;

/** Where the active credential comes from; `injected` is the explicit host test seam. */
export type LocalProviderSource = 'saved' | 'external' | 'injected' | 'none';
/** Derived connection state. `unverified` and `invalid_model` always fail closed. */
export type LocalProviderState =
  'connected' | 'disconnected' | 'unverified' | 'absent' | 'restored' | 'invalid_model';
export type LocalProviderCheckOutcome =
  'ok' | 'auth' | 'network' | 'timeout' | 'cancelled' | 'server' | 'unavailable';

export interface LocalProviderCheckMetadata {
  readonly outcome: LocalProviderCheckOutcome;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly models: readonly string[];
  readonly modelSupported: boolean;
  readonly source: LocalProviderSource;
  readonly revision: number;
  readonly checkedAt: string;
}
export interface LocalProviderModelCapability {
  readonly model: string;
  readonly imageInput: boolean;
}
export interface LocalProviderStatus {
  readonly provider: string;
  readonly source: LocalProviderSource;
  readonly state: LocalProviderState;
  /** Selected profile default model, or null when no credential is configured. */
  readonly model: string | null;
  /** Models the adapter advertises; never derived from a vendor body. */
  readonly models: readonly string[];
  /** Documented per-model capabilities; absent metadata never claims image input. */
  readonly modelCapabilities: readonly LocalProviderModelCapability[];
  readonly revision: number;
  /** Whether an Ocean-managed saved key exists; never the key itself. */
  readonly savedKey: boolean;
  /** Whether this host accepts owner mutations right now. */
  readonly writable: boolean;
  /** Stable diagnostic code for a fail-closed state, else null. */
  readonly code: string | null;
  readonly lastCheck: LocalProviderCheckMetadata | null;
}
export interface LocalProviderCheckResult extends LocalProviderCheckMetadata {
  /** False when nothing was stored: a stale revision or an external source with no row. */
  readonly persisted: boolean;
}
export interface LocalProviderCheckResponse {
  readonly status: LocalProviderStatus;
  readonly check: LocalProviderCheckResult;
}
export interface LocalProviderSetRequest {
  readonly requestId: string;
  readonly key?: string;
  readonly model: string;
}
export interface LocalProviderRevisionRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
}

const localId = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 128;
const position = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((key) => Object.hasOwn(v, key))
  );
}
const statusKeys = [
  'provider',
  'source',
  'state',
  'model',
  'models',
  'modelCapabilities',
  'revision',
  'savedKey',
  'writable',
  'code',
  'lastCheck',
] as const;
const checkKeys = [
  'outcome',
  'httpStatus',
  'durationMs',
  'models',
  'modelSupported',
  'source',
  'revision',
  'checkedAt',
] as const;
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
export const isLocalProviderStatus = (v: unknown): v is LocalProviderStatus =>
  localRuntimeRecord(v) &&
  onlyKeys(v, statusKeys) &&
  bounded(v['provider'], 64) &&
  ['saved', 'external', 'injected', 'none'].some((source) => source === v['source']) &&
  ['connected', 'disconnected', 'unverified', 'absent', 'restored', 'invalid_model'].some(
    (state) => state === v['state'],
  ) &&
  (v['model'] === null || bounded(v['model'], LOCAL_PROVIDER_MODEL_MAX)) &&
  isModels(v['models']) &&
  isCapabilities(v['modelCapabilities']) &&
  position(v['revision']) &&
  typeof v['savedKey'] === 'boolean' &&
  typeof v['writable'] === 'boolean' &&
  (v['code'] === null || (typeof v['code'] === 'string' && /^[a-z_]{1,64}$/.test(v['code']))) &&
  (v['lastCheck'] === null || isCheckMetadata(v['lastCheck']));
function isModels(v: unknown): v is readonly string[] {
  return (
    Array.isArray(v) &&
    v.length <= LOCAL_PROVIDER_MODELS_MAX &&
    v.every((model) => bounded(model, LOCAL_PROVIDER_MODEL_MAX))
  );
}
function isCapabilities(v: unknown): v is readonly LocalProviderModelCapability[] {
  return (
    Array.isArray(v) &&
    v.length <= LOCAL_PROVIDER_MODELS_MAX &&
    v.every(
      (item) =>
        localRuntimeRecord(item) &&
        bounded(item['model'], LOCAL_PROVIDER_MODEL_MAX) &&
        typeof item['imageInput'] === 'boolean' &&
        Object.keys(item).length === 2,
    )
  );
}
function isCheckMetadata(v: unknown): v is LocalProviderCheckMetadata {
  return (
    localRuntimeRecord(v) &&
    onlyKeys(v, checkKeys) &&
    ['ok', 'auth', 'network', 'timeout', 'cancelled', 'server', 'unavailable'].some(
      (x) => x === v['outcome'],
    ) &&
    (v['httpStatus'] === null ||
      (position(v['httpStatus']) && v['httpStatus'] >= 100 && v['httpStatus'] <= 599)) &&
    position(v['durationMs']) &&
    isModels(v['models']) &&
    typeof v['modelSupported'] === 'boolean' &&
    ['saved', 'external', 'injected', 'none'].some((source) => source === v['source']) &&
    position(v['revision']) &&
    typeof v['checkedAt'] === 'string' &&
    Number.isFinite(Date.parse(v['checkedAt']))
  );
}
export function isLocalProviderQuery(v: unknown): v is Record<string, never> {
  return localRuntimeRecord(v) && Object.keys(v).length === 0;
}
export function isLocalProviderSetRequest(v: unknown): v is LocalProviderSetRequest {
  return (
    localRuntimeRecord(v) &&
    localId(v['requestId']) &&
    bounded(v['model'], LOCAL_PROVIDER_MODEL_MAX) &&
    (v['key'] === undefined ||
      (bounded(v['key'], LOCAL_PROVIDER_KEY_MAX) && v['key'].trim() !== '')) &&
    Object.keys(v).every((key) => ['requestId', 'key', 'model'].includes(key))
  );
}
export function isLocalProviderRevisionRequest(v: unknown): v is LocalProviderRevisionRequest {
  return (
    exact(v, ['requestId', 'expectedRevision']) &&
    localId(v['requestId']) &&
    position(v['expectedRevision'])
  );
}
export function isLocalProviderCheckResponse(v: unknown): v is LocalProviderCheckResponse {
  if (!exact(v, ['status', 'check']) || !isLocalProviderStatus(v['status'])) return false;
  if (!localRuntimeRecord(v['check'])) return false;
  const { persisted, ...metadata } = v['check'];
  return typeof persisted === 'boolean' && isCheckMetadata(metadata);
}
