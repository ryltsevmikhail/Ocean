import { expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs';
import { recordedPidRetired } from '../../test-fixtures/mcp-native-observation.js';
const state = vi.hoisted(() => ({ code: 'ENOENT' }));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof Fs>()),
  readFileSync: (path: string) => {
    if (path === '/proc/424242/stat')
      throw Object.assign(Error('synthetic failure'), { code: state.code });
    throw Error('unexpected read');
  },
}));
it('treats only ENOENT as PID absence and fails proof on EACCES', () => {
  state.code = 'ENOENT';
  expect(recordedPidRetired(424242, '123')).toBe(true);
  state.code = 'EACCES';
  expect(() => recordedPidRetired(424242, '123')).toThrow('synthetic failure');
});
