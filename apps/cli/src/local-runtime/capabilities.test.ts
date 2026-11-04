import { describe, expect, it } from 'vitest';
import { LOCAL_PLUGIN_METHODS, LOCAL_PLUGIN_READ_METHODS } from '@runnets/contracts';
import { runtimeCapabilities } from './capabilities.js';

describe('runtime capabilities for plugin methods', () => {
  it('advertises every owner mutation on a writable runtime', () => {
    const capabilities = runtimeCapabilities(false);
    for (const method of LOCAL_PLUGIN_METHODS) expect(capabilities).toContain(method);
  });

  it('advertises reads only on a restore-mode or restored profile runtime', () => {
    // The host passes `restore || restored`, so a restored-not-yet-rebound profile
    // gets the same read-only advertisement as an explicit restore host.
    const capabilities = runtimeCapabilities(true);
    for (const method of LOCAL_PLUGIN_READ_METHODS) expect(capabilities).toContain(method);
    for (const method of LOCAL_PLUGIN_METHODS)
      if (!(LOCAL_PLUGIN_READ_METHODS as readonly string[]).includes(method))
        expect(capabilities).not.toContain(method);
    expect(capabilities).not.toContain('plugin.install');
    expect(capabilities).not.toContain('plugin.access-grant');
    expect(capabilities).not.toContain('plugin.repair');
  });
});
