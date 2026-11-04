/**
 * Exact-origin normalisation, dependency-free.
 *
 * Kept separate from the guarded HTTP layer so the public transport can
 * validate configuration (and raise `invalid_options`) before any Effect/SDK
 * runtime is constructed, without dragging Effect types into its declaration
 * graph.
 */

/**
 * Parse an exact origin (`http(s)://host[:port]`, no path/query/fragment and no
 * credentials) and return the normalised `url.origin`.
 */
export function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`allowed origin must be http(s): ${origin}`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`allowed origin must be scheme://host[:port] with no path: ${origin}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`allowed origin must not carry credentials: ${origin}`);
  }
  return url.origin;
}

/** Normalise a non-empty allowlist; throws on an empty list. */
export function normalizeAllowedOrigins(origins: readonly string[]): readonly string[] {
  if (origins.length === 0) throw new Error('at least one allowed origin is required');
  return [...new Set(origins.map(normalizeOrigin))];
}
