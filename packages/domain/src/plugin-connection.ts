/**
 * Plugin connection model.
 *
 * A connection is an owner-named reference to an account on one installed
 * plugin. It stores the environment variable NAME that holds the credential,
 * never the value. Its monotonic generation invalidates every grant issued for
 * an older authority snapshot.
 */

const DIGEST = /^[a-f0-9]{64}$/;

/** A schema digest is lowercase SHA-256 hex; it is published only from a complete discovery. */
export function validPluginSchemaDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}
export type PluginConnectionState = 'active' | 'disconnected';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** Named connections: `work` and `personal` are distinct rows of one plugin. */
export function validPluginConnectionName(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value);
}

export function validPluginConnectionState(value: unknown): value is PluginConnectionState {
  return value === 'active' || value === 'disconnected';
}

/** Owner-visible identity label; `verified` only after a bounded observed proof. */
export type PluginIdentityLabel = 'verified' | 'unverified';

export function pluginIdentityLabel(input: {
  readonly identity: string | null;
  readonly identityVerified: boolean;
}): PluginIdentityLabel {
  return input.identity !== null && input.identity.length > 0 && input.identityVerified
    ? 'verified'
    : 'unverified';
}
