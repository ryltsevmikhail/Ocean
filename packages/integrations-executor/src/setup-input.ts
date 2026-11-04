/** Plain input validation for the execution-disabled plugin setup seam. */

import { ExecutorSetupError } from './setup-error.js';

export const SETUP_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const SETUP_SLUG = /^[A-Za-z0-9_.-]{1,64}$/;
export const SETUP_CREDENTIAL_REFERENCE = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function invalidOptions(message: string): never {
  throw new ExecutorSetupError('invalid_options', message);
}

export function invalidInput(message: string): never {
  throw new ExecutorSetupError('invalid_input', message);
}

export function exactKeys(value: unknown, keys: readonly string[], what: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalidInput(what + ' must be an object');
  const names = Object.keys(value);
  if (names.length !== keys.length || names.some((name) => !keys.includes(name)))
    invalidInput(what + ' has unexpected fields');
}

export function bounded(value: unknown, max: number, what: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > max ||
    value.includes('\0')
  )
    invalidInput(what + ' is invalid');
  return value;
}

/** Exact HTTPS endpoint that is also in the configured origin allowlist. */
export function httpsEndpoint(value: unknown, allowedOrigins: readonly string[]): string {
  if (typeof value !== 'string' || value.length > 2048) invalidInput('endpoint is invalid');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidInput('endpoint is not an absolute URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    invalidInput('endpoint must be HTTPS with no credentials, query or fragment');
  if (!allowedOrigins.includes(url.origin)) invalidInput('endpoint origin is not allowed');
  return value;
}

/** Stable, value-free failure text for wrapping an SDK setup error. */
export function safeFailure(error: unknown): string {
  if (error instanceof Error && /^[a-zA-Z0-9_. -]{1,120}$/.test(error.message))
    return error.message;
  return 'setup failed';
}
