import { describe, expect, it } from 'vitest';
import {
  LOCAL_BROADCAST_METHODS,
  LOCAL_BROADCAST_READ_METHODS,
  LOCAL_PLUGIN_METHODS,
  LOCAL_PLUGIN_READ_METHODS,
} from '@runnets/contracts';
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
  it('advertises every plugin owner mutation on a writable runtime', () => {
    const capabilities = runtimeCapabilities(false);
    for (const method of LOCAL_PLUGIN_METHODS) expect(capabilities).toContain(method);
  });
  it('advertises plugin reads only on a restore-mode maintenance host', () => {
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

it('negotiates one room task feature only on an ordinary host', () => {
  expect(runtimeCapabilities(false)).toContain('room.tasks-v1');
  expect(runtimeCapabilities(false).filter((s) => s.startsWith('roomTasks.'))).toEqual([]);
  expect(runtimeCapabilities(false).length).toBeLessThanOrEqual(80);
  expect(runtimeCapabilities(true)).not.toContain('room.tasks-v1');
});
