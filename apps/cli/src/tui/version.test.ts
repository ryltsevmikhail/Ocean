/**
 * Version probe tests: the flag is recognised from any argv position (the
 * desktop engine runs `<command> --version`) and the CLI version is populated
 * from the package manifest.
 */

import { describe, expect, it } from 'vitest';

import { CLI_VERSION, isVersionRequest } from '../version.js';

describe('version probe', () => {
  it('exposes the package version', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it('recognises --version and -V from any command position', () => {
    expect(isVersionRequest(['--version'])).toBe(true);
    expect(isVersionRequest(['-V'])).toBe(true);
    expect(isVersionRequest(['acp', '--version'])).toBe(true);
    expect(isVersionRequest(['tui', '-V'])).toBe(true);
  });

  it('does not treat a command or its arguments as a version request', () => {
    expect(isVersionRequest([])).toBe(false);
    expect(isVersionRequest(['version'])).toBe(false);
    expect(isVersionRequest(['demo', '--json'])).toBe(false);
    expect(isVersionRequest(['--versioned'])).toBe(false);
  });
});
