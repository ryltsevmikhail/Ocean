import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validServiceConfiguration } from '@runnets/domain';
import { prepareManagedStdio } from '@runnets/tools-node';
it('accepts only the pinned sibling manifest and the isolated workspace argument', () => {
  const config = {
    kind: 'stdio',
    executable: '/opt/artifact',
    sha256: 'a'.repeat(64),
    packageJsonSha256: 'b'.repeat(64),
    args: ['/workspace'],
  };
  expect(validServiceConfiguration(config)).toBe(true);
  for (const invalid of [
    { args: ['--token=opaque'] },
    { args: ['/workspace', '/tmp'] },
    { packageJsonSha256: 'secret' },
    { packageJson: '/host/file' },
  ]) {
    expect(validServiceConfiguration({ ...config, ...invalid })).toBe(false);
  }
});
it.each(['changed', 'symlink'])(
  'refuses a %s manifest before launching the server',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-pin-'));
    try {
      const profileRoot = join(dir, 'profile'),
        workspace = join(dir, 'workspace'),
        artifact = join(dir, 'server.mjs');
      await mkdir(profileRoot);
      await mkdir(workspace);
      await writeFile(artifact, 'server');
      const manifest = join(dir, 'package.json');
      if (mode === 'changed') await writeFile(manifest, 'changed');
      else await symlink(artifact, manifest);
      const digest = (s: string) => createHash('sha256').update(s).digest('hex');
      await expect(
        prepareManagedStdio({
          profileRoot,
          workspace,
          artifact,
          connectionId: 'test',
          sha256: digest('server'),
          packageJsonSha256: digest('manifest'),
          args: ['/workspace'],
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  },
);
