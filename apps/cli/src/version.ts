/**
 * CLI version resolution.
 *
 * The version is read from the package manifest next to the entry point, so
 * `runne --version` also answers for `runne acp --version` probes from an
 * engine. Unreadable or malformed metadata falls back to `0.0.0` instead of
 * failing the CLI at import time.
 */

import { readFileSync } from 'node:fs';

const FALLBACK_VERSION = '0.0.0';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.trim() !== '') return version.trim();
    }
  } catch {
    // package.json is metadata only; the CLI must still start without it.
  }
  return FALLBACK_VERSION;
}

/** Version reported by `runne --version` and `runne -V`. */
export const CLI_VERSION = readVersion();

/** True when argv asks for the version from any command position. */
export function isVersionRequest(argv: readonly string[]): boolean {
  return argv.some((argument) => argument === '--version' || argument === '-V');
}
