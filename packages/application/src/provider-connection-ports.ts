/**
 * Provider connection ports.
 *
 * The runtime owns credentials: the metadata store keeps only opaque secret
 * references, the secret store keeps the bytes on the private filesystem, and
 * the host supplies a credential adapter that binds a key to a provider and a
 * bounded model probe. Nothing here sees vendor wire shapes.
 */

import type { ProviderPort } from './provider.js';

export type ProviderConnectionSource = 'saved' | 'external' | 'injected' | 'none';
export type ProviderConnectionState =
  'connected' | 'disconnected' | 'unverified' | 'absent' | 'restored' | 'invalid_model';
export type ProviderCheckOutcome =
  'ok' | 'auth' | 'network' | 'timeout' | 'cancelled' | 'server' | 'unavailable';

/** Persisted bounded check metadata; never vendor body text and never a key. */
export interface ProviderCheckMetadata {
  readonly outcome: ProviderCheckOutcome;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly models: readonly string[];
  readonly modelSupported: boolean;
  readonly source: ProviderConnectionSource;
  readonly revision: number;
  readonly checkedAt: string;
}
export interface ProviderCheckResult extends ProviderCheckMetadata {
  readonly persisted: boolean;
}
export interface ProviderSetInput {
  readonly requestId: string;
  readonly key?: string;
  readonly model: string;
}
export interface ProviderRevisionInput {
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface ProviderConnectionStatus {
  readonly provider: string;
  readonly source: ProviderConnectionSource;
  readonly state: ProviderConnectionState;
  readonly model: string | null;
  readonly models: readonly string[];
  readonly modelCapabilities: readonly ProviderModelCapability[];
  readonly revision: number;
  readonly savedKey: boolean;
  readonly writable: boolean;
  readonly code: string | null;
  readonly lastCheck: ProviderCheckMetadata | null;
}
export interface ProviderConnectionCheck {
  readonly status: ProviderConnectionStatus;
  readonly check: ProviderCheckResult;
}

/** Durable intent. `pending` means an intent was persisted but not verified as activated. */
export type ProviderConnectionIntent = 'active' | 'disconnected' | 'pending';

/**
 * One provider's authoritative metadata row. `secretRef` is an opaque handle,
 * `requestId`/`binding` record the owner request that produced this revision and
 * `binding` is a digest of the request payload (never the payload bytes).
 */
export interface ProviderConnectionRecord {
  readonly provider: string;
  readonly model: string | null;
  readonly secretRef: string | null;
  readonly intent: ProviderConnectionIntent;
  readonly revision: number;
  readonly requestId: string | null;
  readonly binding: string | null;
  readonly lastCheck: ProviderCheckMetadata | null;
  readonly updatedAt: string;
}
export interface ProviderConnectionReceipt {
  readonly binding: string;
  readonly result: ProviderConnectionStatus;
}
/** Authoritative metadata store; CAS writes make stale owner intents explicit. */
export interface ProviderConnectionStorePort {
  read(provider: string): ProviderConnectionRecord | null;
  /** Write only when the stored revision equals `expected` (null: no row yet). */
  put(record: ProviderConnectionRecord, expected: number | null): void;
  /** Persist the activated record and its idempotency receipt in one transaction. */
  activate(
    record: ProviderConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ProviderConnectionReceipt },
  ): void;
  receipt(requestId: string): ProviderConnectionReceipt | null;
}

/** Opaque reference read from the private secret store; malformed files fail closed. */
export type ProviderSecretRead =
  | { readonly status: 'ok'; readonly key: string }
  | { readonly status: 'absent' }
  | {
      readonly status: 'unverified';
      readonly reason: 'provider_secret_corrupt' | 'provider_secret_insecure';
    };
/** Private 0700/0600 credential storage outside the profile and its backup. */
export interface ProviderSecretStorePort {
  read(ref: string): ProviderSecretRead;
  /** Atomic, fsynced publication; throws a stable code on an insecure store. */
  write(ref: string, key: string): void;
  /**
   * Publish `ref` while deleting `previous` in the same atomic publication, so a
   * rotation can never leave a silently retained old value behind.
   */
  replace(previous: string | null, ref: string, key: string): void;
  /** Delete one opaque reference; the owner requested removing that value. */
  remove(ref: string): void;
}
export type ProviderProbeResult =
  | { readonly outcome: 'ok'; readonly httpStatus: number; readonly models: readonly string[] }
  | {
      readonly outcome: Exclude<ProviderCheckOutcome, 'ok'>;
      readonly httpStatus: number | null;
      readonly models: readonly string[];
    };
/** One immutable credential activation: provider snapshot plus bounded model probe. */
export interface ProviderCredential {
  readonly source: 'saved' | 'external';
  readonly provider: ProviderPort;
  check(signal: AbortSignal): Promise<ProviderProbeResult>;
}
/** Declared per-model capability; unknown capabilities are never inferred. */
export interface ProviderModelCapability {
  readonly model: string;
  readonly imageInput: boolean;
}
/** Host composition seam; only adapters know how a key becomes a provider. */
export interface ProviderCredentialPort {
  readonly providerId: string;
  /** Models the adapter advertises. Identity metadata, never a vendor response. */
  readonly models: readonly string[];
  /** Documented per-model capabilities surfaced in status; no guessing. */
  readonly modelCapabilities: readonly ProviderModelCapability[];
  /** Build the immutable activation bound to one saved key. */
  own(key: string): ProviderCredential;
  /** Environment activation; present only when the host environment supplies a key. */
  environment(): ProviderCredential | null;
}
