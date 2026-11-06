import type * as SandboxProbe from './sandbox-probe.js';
import type { ToolDispatchGuard } from '@runnets/application';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type * as Mounts from './sandbox-mounts.js';
import type { CodingApprovalBinding, CodingTask } from '@runnets/domain';
import { createCodingOperationSession, prepareCodingOperation } from './coding-operation.js';
const mutation = vi.hoisted(() => ({ path: '', revoke: () => {} }));
const scripted = vi.hoisted(() => ({ enabled: false, writes: 0 }));
vi.mock('./sandbox-probe.js', async (original) => {
  const actual = await original<typeof SandboxProbe>();
  return {
    ...actual,
    createSandboxBackend: async (...args: Parameters<typeof actual.createSandboxBackend>) =>
      scripted.enabled
        ? {
            capabilities: {
              filesystemContainment: true,
              processContainment: true,
              confirmedTreeStop: true,
            },
            read: async () => null,
            list: async () => [],
            write: async (
              _p: string,
              _c: string,
              _e: unknown,
              _s: AbortSignal,
              guard?: ToolDispatchGuard,
            ) => {
              await guard?.prepare?.();
              if (!guard?.authorize()) throw Error('denied');
              scripted.writes++;
            },
            command: async () => ({ isError: false, output: '' }),
          }
        : actual.createSandboxBackend(...args),
  };
});
vi.mock('./sandbox-mounts.js', async (original) => {
  const mounts = await original<typeof Mounts>();
  return {
    ...mounts,
    async fingerprintFile(path: string) {
      const result = await mounts.fingerprintFile(path);
      mutation.revoke();
      if (mutation.path) {
        const target = mutation.path;
        mutation.path = '';
        await writeFile(target, 'changed during hashing');
      }
      return result;
    },
  };
});
const binding: CodingApprovalBinding = {
  workspaceId: 'w',
  taskId: 't',
  projectRoot: '/p',
  worktreeRoot: '/wt',
  roomId: 'r',
  botId: 'b',
  runId: 'run',
  attemptId: 'a',
  invocationId: 'i',
  operation: 'write',
  operationHash: 'patch',
  sourceTreeHash: 'tree',
  policyVersion: 1,
  limitsHash: 'limits',
  toolchainHash: 'tools',
};
const task: CodingTask = {
  id: 't',
  workspaceId: 'w',
  projectRoot: '/p',
  worktreeRoot: '/wt',
  baseCommit: 'base',
  ownerRoomId: 'r',
  devBotId: 'b',
  reviewBotId: 'review',
  reviewRoomId: 'review-room',
  status: 'reserved',
  policyVersion: 1,
  policy: {
    version: 1,
    devCapabilities: ['propose_write'],
    reviewCapabilities: ['changeset_read'],
    testPresets: [],
  },
  lease: {
    ownerId: 'owner',
    taskId: 't',
    requestId: 'request',
    binding: 'binding',
    kind: 'coding',
    projectRoot: '/p',
    token: 'token',
  },
  createdAt: '2026-11-02',
};

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'prepares an exact new-file operation without dispatching it',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-operation-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      const prepared = await prepareCodingOperation({
        task: { ...task, worktreeRoot: root },
        scope: binding,
        approvalId: 'approval',
        sandbox: { root },
        snapshot: async () => 'tree',
        call: {
          id: binding.invocationId,
          name: 'write_file',
          arguments: JSON.stringify({ path: 'new', content: 'after' }),
        },
      });
      expect(prepared.binding).toMatchObject({
        taskId: 't',
        worktreeRoot: root,
        operation: 'write',
        sourceTreeHash: 'tree',
      });
      expect(prepared.tool.preview).toContain('after');
      await expect(readFile(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(prepared.binding.operationHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains read history for edits and refuses source changed after the read',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-operation-session-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      await writeFile(join(root, 'source'), 'before');
      const session = await createCodingOperationSession({
        task: {
          ...task,
          worktreeRoot: root,
          policy: { ...task.policy, devCapabilities: ['project_read', 'propose_write'] },
        },
        scope: binding,
        sandbox: { root },
        snapshot: () => readFile(join(root, 'source'), 'utf8'),
      });
      const edit = {
        id: 'edit',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'source', content: 'after' }),
      };
      await expect(session.prepare('approval', edit)).rejects.toMatchObject({ code: 'stale_read' });
      await session.read(
        { id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'source' }) },
        new AbortController().signal,
      );
      const prepared = await session.prepare('approval', edit, 'actual-attempt');
      expect(prepared.binding.attemptId).toBe('actual-attempt');
      expect(prepared.tool.preview).toContain('before');
      await writeFile(join(root, 'source'), 'owner change');
      await expect(prepared.tool.execute(new AbortController().signal)).rejects.toThrow();
      expect(await readFile(join(root, 'source'), 'utf8')).toBe('owner change');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  12_000,
);

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'takes the final source snapshot after asynchronous toolchain hashing',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-binding-source-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      await writeFile(join(root, 'source'), 'before');
      const prepared = await prepareCodingOperation({
        task: { ...task, worktreeRoot: root },
        scope: binding,
        approvalId: 'approval',
        sandbox: { root },
        snapshot: () => readFile(join(root, 'source'), 'utf8'),
        call: {
          id: binding.invocationId,
          name: 'write_file',
          arguments: JSON.stringify({ path: 'new', content: 'after' }),
        },
      });
      mutation.path = join(root, 'source');
      expect((await prepared.currentBinding()).sourceTreeHash).toBe('changed during hashing');
      expect(prepared.binding.sourceTreeHash).toBe('before');
    } finally {
      mutation.path = '';
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('rechecks preparation inspection after asynchronous hashing before any snapshot read', async () => {
  scripted.enabled = true;
  let allowed = true,
    reads = 0;
  mutation.revoke = () => {
    allowed = false;
  };
  try {
    await expect(
      prepareCodingOperation({
        task,
        scope: binding,
        approvalId: 'approval',
        sandbox: { root: '/wt' },
        call: { id: 'i', name: 'write_file', arguments: '{"path":"new","content":"after"}' },
        guard: { authorize: () => true, inspect: () => allowed },
        snapshot: async () => {
          reads++;
          return 'tree';
        },
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  } finally {
    scripted.enabled = false;
    mutation.revoke = () => {};
  }
});
it('repeats snapshot inspection without consuming the actual mutation dispatch', async () => {
  scripted.enabled = true;
  scripted.writes = 0;
  let inspections = 0,
    sends = 0;
  try {
    const prepared = await prepareCodingOperation({
      task,
      scope: binding,
      approvalId: 'approval',
      sandbox: { root: '/wt' },
      call: { id: 'i', name: 'write_file', arguments: '{"path":"new","content":"after"}' },
      guard: {
        authorize: () => true,
        inspect: () => {
          inspections++;
          return true;
        },
      },
      snapshot: async () => 'tree',
    });
    await prepared.currentBinding();
    await prepared.tool.execute(new AbortController().signal, { authorize: () => ++sends === 1 });
    expect(inspections).toBeGreaterThanOrEqual(3);
    expect(sends).toBe(1);
    expect(scripted.writes).toBe(1);
  } finally {
    scripted.enabled = false;
  }
});
it('refuses a revoked execution snapshot before any subsequent tree read or mutation', async () => {
  scripted.enabled = true;
  scripted.writes = 0;
  let allowed = true,
    reads = 0;
  try {
    const prepared = await prepareCodingOperation({
      task,
      scope: binding,
      approvalId: 'approval',
      sandbox: { root: '/wt' },
      call: { id: 'i', name: 'write_file', arguments: '{"path":"new","content":"after"}' },
      guard: { authorize: () => allowed, inspect: () => allowed },
      snapshot: async () => {
        reads++;
        return 'tree';
      },
    });
    expect(reads).toBe(1);
    allowed = false;
    await expect(
      prepared.tool.execute(new AbortController().signal, {
        authorize: () => {
          throw Error('must not dispatch');
        },
      }),
    ).rejects.toThrow();
    expect(reads).toBe(1);
    expect(scripted.writes).toBe(0);
  } finally {
    scripted.enabled = false;
  }
});
