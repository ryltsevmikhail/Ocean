import type { ToolDispatchGuard } from '@runnets/application';
import { expect, it, vi } from 'vitest';
import { GitCodingWorktrees } from '@runnets/tools-node';
import { setup, settledRead, script } from '../test-fixtures/room-coding.js';
const scans = vi.hoisted(() => ({ base: 0, tree: 0, writes: 0, preparationReads: 0 }));
// Only physical worker/scan ports are scripted; factory, session, operation and capture are real.
vi.mock('../../../packages/tools-node/src/sandbox-probe.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createSandboxBackend: async () => ({
    capabilities: {
      filesystemContainment: true,
      processContainment: true,
      confirmedTreeStop: true,
    },
    read: async () => {
      scans.preparationReads++;
      return null;
    },
    list: async () => [],
    write: async () => {
      scans.writes++;
    },
    command: async () => ({ isError: false, output: '' }),
  }),
}));
vi.mock('../../../packages/tools-node/src/coding-working-tree.js', () => ({
  codingBaseFiles: async () => {
    scans.base++;
    return new Map();
  },
  codingWorkingTree: async () => {
    scans.tree++;
    return new Map();
  },
  codingManifest: () => 'tree',
}));
it('forwards the actual marked invocation guard through session/capture and refuses scans after async live-lease loss', async () => {
  script.realSession = true;
  scans.base = 0;
  scans.tree = 0;
  scans.writes = 0;
  scans.preparationReads = 0;
  const f = setup();
  let verified = 0,
    capturedGuard: ToolDispatchGuard | undefined;
  const lease = f.store.coding.atomic((tx) => tx.worktree(f.b.id)!.lease);
  vi.spyOn(GitCodingWorktrees.prototype, 'verify').mockImplementation(
    async (_task, _binding, guard) => {
      capturedGuard = guard;
      expect(guard?.inspect?.()).toBe(true);
      await Promise.resolve();
      verified++;
      f.live.delete(lease.token);
    },
  );
  try {
    const r = await settledRead(f);
    expect(f.deps.leases.owns(lease)).toBe(true);
    const result = await r.tools.execute(
      {
        id: r.context.attemptId + '_r1_write',
        name: 'write_file',
        arguments: '{"path":"new","content":"after"}',
      },
      r.controller.signal,
      r.context,
    );
    expect(verified).toBeGreaterThanOrEqual(1);
    expect(f.deps.leases.owns(lease)).toBe(false);
    expect(capturedGuard?.inspect?.()).toBe(false);
    expect(result).toMatchObject({ isError: true });
    expect(scans).toEqual({ base: 0, tree: 0, writes: 0, preparationReads: 1 });
    expect(verified).toBe(1);
    expect(f.db.prepare('SELECT count(*) AS n FROM ocean_coding_approvals').get()?.['n']).toBe(0);
    expect(f.db.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
