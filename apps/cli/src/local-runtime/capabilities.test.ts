import { describe, expect, it } from 'vitest';
import { LOCAL_BROADCAST_METHODS, LOCAL_BROADCAST_READ_METHODS } from '@runnets/contracts';
import { runtimeCapabilities } from './capabilities.js';

describe('runtime capabilities', () => {
  it('advertises the full broadcast API on a normal host', () => {
    const capabilities = runtimeCapabilities(false);
    for (const method of LOCAL_BROADCAST_METHODS) expect(capabilities).toContain(method);
    expect(capabilities[0]).toBe('status');
    expect(capabilities[1]).toBe('stop');
  });
  it('advertises only broadcast reads on a restore-mode maintenance host', () => {
    const capabilities = runtimeCapabilities(true);
    for (const read of LOCAL_BROADCAST_READ_METHODS) expect(capabilities).toContain(read);
    for (const mutation of ['broadcasts.submit', 'broadcasts.continue', 'broadcasts.abandon'])
      expect(capabilities).not.toContain(mutation);
    expect(capabilities).toContain('restore.maintenance');
  });
});
