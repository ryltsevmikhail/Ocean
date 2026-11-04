/**
 * Plugin connection model.
 *
 * A connection is an owner-named reference to an account on one installed
 * plugin. It stores the environment variable NAME that holds the credential,
 * never the value. Its monotonic generation invalidates every grant issued for
 * an older authority snapshot.
 */

/** Authority-relevant change classes; each one increments the connection generation. */
export const PLUGIN_CONNECTION_GENERATION_CHANGES = Object.freeze([
  'account',
  'adapter',
  'credential',
  'endpoint',
  'plugin',
  'schema',
] as const);
export type PluginConnectionGenerationChange =
  (typeof PLUGIN_CONNECTION_GENERATION_CHANGES)[number];

const DIGEST = /^[a-f0-9]{64}$/;

/** A schema digest is lowercase SHA-256 hex; it is published only from a complete discovery. */
export function validPluginSchemaDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}
export type PluginConnectionState = 'active' | 'disconnected';

/**
 * Increment a generation. Only the six authority-bearing change classes may do
 * so; any other input is a programming error, not a silent no-op.
 */
export function nextPluginConnectionGeneration(
  generation: number,
  change: PluginConnectionGenerationChange,
): number {
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new RangeError('plugin connection generation must be a positive integer');
  if (!PLUGIN_CONNECTION_GENERATION_CHANGES.includes(change))
    throw new RangeError('unknown plugin connection change: ' + String(change));
  return generation + 1;
}

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
