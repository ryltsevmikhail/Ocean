import { mkdtemp, rm, readFile, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { sandboxFile } from './sandbox-files.js';
import { createNativeBackend } from './native.js';
import { validateMounts } from './sandbox-mounts.js';
describe('sandbox mount refusal', () => {
  it('refuses home mounts and dependency symlinks outside explicit roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-mount-'));
    try {
      await expect(validateMounts([{ source: root, target: '/home' }])).rejects.toThrow();
      await symlink('/etc/passwd', join(root, 'escape'));
      await expect(
        validateMounts([{ source: root, target: '/workspace/node_modules' }]),
      ).rejects.toThrow();
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
