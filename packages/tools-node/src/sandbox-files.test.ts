import type * as Supervision from './sandbox-supervision.js';
import {
  chmod,
  stat,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  symlink,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { WorkspaceTools } from './executor.js';
import { createSandboxBackend } from './sandbox-probe.js';
import { sandboxFile } from './sandbox-files.js';
import { createNativeBackend } from './native.js';
import { validateMounts } from './sandbox-mounts.js';
const scripted = vi.hoisted(() => ({ enabled: false, effects: 0 }));
vi.mock('./sandbox-supervision.js', async (original) => {
  const actual = await original<typeof Supervision>();
  return {
    ...actual,
    runSandbox: async (request: Parameters<typeof actual.runSandbox>[0]) => {
      if (!scripted.enabled) return actual.runSandbox(request);
      await request.guard?.prepare?.();
      if (!request.guard?.authorize()) throw Error('physical dispatch denied');
      scripted.effects++;
      return {
        cleanupConfirmed: true,
        reason: 'exit',
        exitCode: 0,
        truncated: false,
        output: '{"ok":true,"result":[]}',
      };
    },
  };
});
it.each(['read', 'list'] as const)(
  'forwards %s authority through awaited preparation before the worker',
  async (op) => {
    scripted.enabled = true;
    scripted.effects = 0;
    let allowed = true,
      checks = 0;
    try {
      await expect(
        sandboxFile({ root: '/synthetic' }, { op, path: 'file' }, new AbortController().signal, {
          prepare: async () => {
            await Promise.resolve();
            allowed = false;
          },
          authorize: () => {
            checks++;
            return allowed;
          },
        }),
      ).rejects.toThrow('physical dispatch denied');
      expect(checks).toBe(1);
      expect(scripted.effects).toBe(0);
    } finally {
      scripted.enabled = false;
    }
  },
);
describe('sandbox mount refusal', () => {
  it('refuses home mounts and dependency symlinks outside explicit roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-mount-'));
    try {
      await expect(validateMounts([{ source: root, target: '/home' }])).rejects.toThrow();
      const target = '/workspace/node_modules';
      const source = join(root, 'node_modules');
      await mkdir(source);
      await expect(validateMounts([{ source: root, target }], root)).rejects.toThrow();
      await expect(validateMounts([{ source: root, target: '/toolchain/pnpm' }])).rejects.toThrow();
      await expect(validateMounts([{ source, target }], root)).resolves.toMatch(/^[a-f0-9]{64}$/);
      await writeFile(join(source, 'package'), 'before');
      const originalHash = await validateMounts([{ source, target }], root);
      await writeFile(join(source, 'package'), 'after');
      expect(await validateMounts([{ source, target }], root)).not.toBe(originalHash);
      await symlink('/etc/passwd', join(source, 'escape'));
      await expect(validateMounts([{ source, target }], root)).rejects.toThrow();
      await rm(join(source, 'escape'));
      await writeFile(join(root, 'outside'), 'synthetic-canary');
      await link(join(root, 'outside'), join(source, 'alias'));
      await expect(validateMounts([{ source, target }], root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses absent worktree mountpoints without creating host files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-missing-'));
    try {
      await expect(sandboxFile({ root }, { op: 'list', path: '.' })).rejects.toThrow('mountpoint');
      await expect(stat(join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('legacy native backend has no qualification even though it can see a host canary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-native-'));
    try {
      await writeFile(join(root, 'canary'), 'synthetic-only');
      const backend = await createNativeBackend(root);
      expect(await backend.read('canary')).toBe('synthetic-only');
      expect(backend.capabilities).toEqual({
        filesystemContainment: false,
        processContainment: false,
        confirmedTreeStop: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'sandbox file worker',
  () => {
    it('preserves exact text and modes, atomically writes and rejects stale content', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-files-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        await writeFile(join(root, 'a'), '\uFEFFbefore\r\n', { mode: 0o755 });
        expect(await sandboxFile({ root }, { op: 'read', path: 'a' })).toBe('\uFEFFbefore\r\n');
        await expect(
          sandboxFile({ root }, { op: 'write', path: 'a', expected: 'stale', content: 'no' }),
        ).rejects.toThrow('refused');
        expect(await readFile(join(root, 'a'), 'utf8')).toBe('\uFEFFbefore\r\n');
        await sandboxFile(
          { root },
          { op: 'write', path: 'a', expected: '\uFEFFbefore\r\n', content: 'after' },
        );
        expect(await readFile(join(root, 'a'), 'utf8')).toBe('after');
        await sandboxFile({ root }, { op: 'write', path: 'new', expected: null, content: 'new' });
        expect(await readFile(join(root, 'new'), 'utf8')).toBe('new');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 20000);
    it('cancels a prepared write during inventory without modifying the task', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-cancel-write-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        const backend = await createSandboxBackend({ root }, [], async () => 'fixture');
        const tools = new WorkspaceTools(backend, { requireContainment: true });
        const edit = await tools.prepare({
          id: 'cancel',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'marker', content: 'unexpected' }),
        });
        const controller = new AbortController();
        const pending = edit.execute(controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await expect(stat(join(root, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('transfers maximum-size write previews through private IPC', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-files-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        const expected = 'a'.repeat(131072);
        const content = 'b'.repeat(131072);
        await writeFile(join(root, 'large'), expected);
        await chmod(join(root, 'large'), 0o777);
        await sandboxFile({ root }, { op: 'write', path: 'large', expected, content });
        expect(await readFile(join(root, 'large'), 'utf8')).toBe(content);
        expect((await stat(join(root, 'large'))).mode & 0o777).toBe(0o777);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('refuses symlink, hardlink and credential-bearing task trees', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-refusal-'));
      try {
        await writeFile(join(root, 'a'), 'x');
        await link(join(root, 'a'), join(root, 'b'));
        await expect(sandboxFile({ root }, { op: 'read', path: 'a' })).rejects.toThrow(
          'unsupported task file',
        );
        await rm(join(root, 'b'));
        await symlink('/etc/passwd', join(root, 'escape'));
        await expect(sandboxFile({ root }, { op: 'read', path: 'escape' })).rejects.toThrow(
          'protected path',
        );
        await rm(join(root, 'escape'));
        await writeFile(join(root, '.env'), 'synthetic');
        await expect(sandboxFile({ root }, { op: 'read', path: 'a' })).rejects.toThrow(
          'protected path',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
