/**
 * Provider connection request helpers.
 *
 * Bound constants and one-way request fingerprinting shared by the service. A
 * key never enters durable state: only `sha256("ocean.provider.key.v1:" + key)`
 * is used to tell two owner payloads apart for idempotency, and the digest
 * cannot reproduce the credential.
 */

/** Matches the wire contract limits; duplicated because application cannot depend on contracts. */
export const PROVIDER_KEY_MAX = 512;
export const PROVIDER_MODEL_MAX = 256;
export const PROVIDER_MODELS_MAX = 200;
/** Hard bound for an explicit owner connection check. */
export const PROVIDER_CHECK_TIMEOUT_MS = 10_000;

const KEY_DOMAIN = 'ocean.provider.key.v1:';

/** Injected hash: the application layer never imports a platform crypto module. */
export type Sha256 = (text: string) => string;
/** One-way fingerprint used only for conflicting-payload detection. */
export function keyDigest(sha256: Sha256, key: string | undefined): string | null {
  return key === undefined ? null : sha256(KEY_DOMAIN + key);
}
export function bindingFor(sha256: Sha256, parts: readonly unknown[]): string {
  return sha256(JSON.stringify(parts));
}
/** Extract a stable lowercase code; never vendor text, never a thrown message with secrets. */
export function requestCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z_]{1,64}$/.test(message) ? message : fallback;
}
/** Validate a submitted credential without echoing its value. */
export function validKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PROVIDER_KEY_MAX ||
    value.trim() === '' ||
    value.includes('\0')
  )
    throw Error('invalid_params');
  return value;
}
export function validModel(value: unknown, advertised: readonly string[]): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PROVIDER_MODEL_MAX ||
    value.includes('\0')
  )
    throw Error('invalid_params');
  if (!advertised.includes(value)) throw Error('provider_invalid_model');
  return value;
}
export function validRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128)
    throw Error('invalid_params');
  return value;
}
export function validRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('invalid_params');
  return value;
}
/** One bounded owner-check deadline, combined with the calling connection's lifetime. */
export function checkSignal(external: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS);
  return external === undefined ? timeout : AbortSignal.any([external, timeout]);
}
