import { expect, it, vi } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpServiceTransport } from './index.js';
import { connection } from '../test-fixtures/admission.js';
it.each(['missing', 'contradictory'])(
  'refuses %s enrollment before SDK process launch',
  async (mode) => {
    const starts = vi.spyOn(StdioClientTransport.prototype, 'start');
    const c = connection({
      kind: 'stdio',
      executable: '/owned/server.mjs',
      sha256: 'a'.repeat(64),
      args: [],
      ...(mode === 'contradictory' ? { workspaceRoot: '/owned/workspace' } : {}),
    });
    const t = createMcpServiceTransport({
      stdio: {
        profileRoot: '/owned/profile',
        ...(mode === 'contradictory' ? { workspaces: { [c.id]: '/different/workspace' } } : {}),
      },
    });
    try {
      await expect(
        t.discover(c, {
          signal: new AbortController().signal,
          deadlineMs: 1000,
          authorizeMetadata: () => true,
        }),
      ).rejects.toThrow();
      expect(starts).not.toHaveBeenCalled();
      expect(await t.close()).toEqual({ status: 'never_started' });
    } finally {
      starts.mockRestore();
      await t.close();
    }
  },
);
