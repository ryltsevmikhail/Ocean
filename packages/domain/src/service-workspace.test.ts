import { expect, it } from 'vitest';
import { validServiceConfiguration } from './service-connection.js';
const base = {
  kind: 'stdio',
  executable: '/artifact/server.mjs',
  sha256: 'a'.repeat(64),
  args: ['/workspace'],
};
it('keeps old inert stdio declarations valid and exact plain absolute enrollment bounded', () => {
  expect(validServiceConfiguration(base)).toBe(true);
  expect(validServiceConfiguration({ ...base, workspaceRoot: '/dedicated/workspace' })).toBe(true);
  expect(
    validServiceConfiguration({
      ...base,
      workspaceRoot: '/dedicated/workspace',
      packageJsonSha256: 'b'.repeat(64),
    }),
  ).toBe(true);
  for (const workspaceRoot of [
    '',
    '/',
    'relative',
    '/a/',
    '/a//b',
    '/a/../b',
    '/a/./b',
    '/a\\b',
    '/a\0b',
  ])
    expect(validServiceConfiguration({ ...base, workspaceRoot }), workspaceRoot).toBe(false);
  expect(validServiceConfiguration({ ...base, workspaceRoot: '/a', mounts: [] })).toBe(false);
});
