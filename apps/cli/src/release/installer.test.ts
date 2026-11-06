import type * as FsModule from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { packageRelease } from './package.js';
import {
  chmodSync,
  statSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from './archive.js';
import { archiveFiles, installArchive, sha256 } from './installer.js';
import { workspace } from '../../test-fixtures/release-repo.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-install-'));
  roots.push(root);
  return root;
}
function artifact(root: string, version = '0.1.0') {
  const files = new Map<string, { body: Buffer; mode: number }>();
  for (const name of ['apps/cli/dist/main.js', 'LICENSE', 'NOTICE', 'package.json'])
    files.set(name, {
      body: Buffer.from(name === 'package.json' ? '{"type":"module"}' : 'test'),
      mode: 0o644,
    });
  files.set('bin/ocean', { body: Buffer.from('#!/bin/sh\n'), mode: 0o755 });
  const manifest = {
    format: 1,
    version,
    revision: 'a'.repeat(40),
    node: process.version,
    platform: 'linux',
    arch: 'x64',
    lockfileSha256: 'b'.repeat(64),
    files: Object.fromEntries(
      [...files].map(([name, e]) => [name, { sha256: sha256(e.body), mode: e.mode }]),
    ),
  };
  files.set('manifest.json', { body: Buffer.from(JSON.stringify(manifest)), mode: 0o644 });
  const bytes = createArchive(files),
    path = join(root, version + '.tar.gz');
  writeFileSync(path, bytes);
  return { path, hash: sha256(bytes) };
}
it('installs, repeats exact installation, upgrades and rolls back without touching profiles', () => {
  const root = temporary(),
    prefix = join(root, 'local'),
    a = artifact(root),
    b = artifact(root, '0.2.0');
  installArchive(a.path, a.hash, prefix);
  installArchive(a.path, a.hash, prefix);
  installArchive(b.path, b.hash, prefix);
  installArchive(a.path, a.hash, prefix);
  expect(readFileSync(join(prefix, 'lib/ocean/current/manifest.json'), 'utf8')).toContain('0.1.0');
  writeFileSync(join(prefix, 'lib/ocean/releases/0.1.0/LICENSE'), 'tampered');
  expect(() => installArchive(a.path, a.hash, prefix)).toThrow('version_conflict');
});
it('rejects wrong checksum, traversal, links, malformed archives and foreign launchers', () => {
  const root = temporary(),
    a = artifact(root),
    prefix = join(root, 'local');
  expect(() => installArchive(a.path, '0'.repeat(64), prefix)).toThrow('checksum_mismatch');
  expect(() =>
    archiveFiles(createArchive(new Map([['../escape', { body: Buffer.from('x'), mode: 0o644 }]]))),
  ).toThrow('invalid_archive');
  expect(() => archiveFiles(Buffer.from('bad'))).toThrow();
  // Archive type is regular-file-only; a symlink type is rejected even with a valid checksum.
  const raw = gunzipSync(readFileSync(a.path));
  raw[156] = 50;
  raw.fill(32, 148, 156);
  const sum = raw.subarray(0, 512).reduce((n, b) => n + b, 0);
  raw.write(sum.toString(8).padStart(7, '0') + '\0', 148, 8);
  expect(() => archiveFiles(gzipSync(raw))).toThrow('invalid_archive');
  installArchive(a.path, a.hash, prefix);
  rmSync(join(prefix, 'bin/ocean'));
  writeFileSync(join(prefix, 'bin/ocean'), 'mine');
  expect(() => installArchive(a.path, a.hash, prefix)).toThrow('unmanaged_launcher');
  const other = join(root, 'linked');
  symlinkSync(prefix, other);
  expect(() => installArchive(a.path, a.hash, other)).toThrow('invalid_prefix');
});

/** Minimal committed release checkout; the standalone Apache-2.0 tree has no LICENSES directory. */
function releaseRepo(base: string, options: { licenses?: boolean } = {}): string {
  mkdirSync(base, { recursive: true });
  const repo = join(base, 'repo');
  mkdirSync(repo);
  for (const dir of ['apps/cli/dist/release', 'packages/domain/dist', 'docs'])
    mkdirSync(join(repo, dir), { recursive: true });
  // A synthetic adapter entry that still bundles the real pinned dependency tree.
  const adapter = join(repo, 'packages/integrations-mcp');
  mkdirSync(join(adapter, 'dist'), { recursive: true });
  mkdirSync(join(adapter, 'THIRD_PARTY_LICENSES'), { recursive: true });
  writeFileSync(
    join(adapter, 'package.json'),
    readFileSync(join(workspace, 'packages/integrations-mcp/package.json')),
  );
  writeFileSync(
    join(adapter, 'dist/index.js'),
    "export * from '@modelcontextprotocol/client';\nexport * from '@modelcontextprotocol/client/stdio';\n",
  );
  writeFileSync(
    join(adapter, 'THIRD_PARTY_LICENSES/modelcontextprotocol-client-LICENSE'),
    'fixture third-party license',
  );
  symlinkSync(
    join(workspace, 'packages/integrations-mcp/node_modules'),
    join(adapter, 'node_modules'),
  );
  symlinkSync(join(workspace, 'node_modules'), join(repo, 'node_modules'));
  if (options.licenses !== false) {
    mkdirSync(join(repo, 'LICENSES'), { recursive: true });
    writeFileSync(join(repo, 'LICENSES/fixture-notice.txt'), 'fixture notice');
  }
  for (const dir of ['apps/cli', 'packages/domain'])
    writeFileSync(
      join(repo, dir, 'package.json'),
      JSON.stringify({ name: dir, type: 'module', main: './dist/index.js' }),
    );
  writeFileSync(
    join(repo, 'apps/cli/dist/main.js'),
    "import {installCommand} from './release/installer.js';process.exitCode=installCommand(process.argv.slice(3));\n//# sourceMappingURL=absent.js.map",
  );
  // Fixture still uses the real compiled standalone installer source.
  const source = readFileSync(new URL('./installer.ts', import.meta.url), 'utf8');
  writeFileSync(join(repo, 'apps/cli/dist/release/installer.js'), stripTypeScriptTypes(source));
  writeFileSync(join(repo, 'packages/domain/dist/index.js'), 'export const fixture=true;');
  for (const name of ['LICENSE', 'NOTICE', 'README.md']) writeFileSync(join(repo, name), 'fixture');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), readFileSync(join(workspace, 'pnpm-lock.yaml')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
    { cwd: repo },
  );
  return repo;
}
it('packages a standalone checkout without a LICENSES tree and includes one when present', async () => {
  const root = temporary(),
    absent = await packageRelease(
      releaseRepo(join(root, 'absent'), { licenses: false }),
      '0.1.0',
      join(root, 'a'),
    ),
    present = await packageRelease(releaseRepo(join(root, 'present')), '0.1.0', join(root, 'b'));
  const absentFiles = archiveFiles(readFileSync(absent.archive)),
    presentFiles = archiveFiles(readFileSync(present.archive));
  expect([...absentFiles.keys()].some((name) => name.startsWith('LICENSES/'))).toBe(false);
  expect(presentFiles.has('LICENSES/fixture-notice.txt')).toBe(true);
});
it('packaged install command upgrades and rolls back from an independent installation', async () => {
  const root = temporary(),
    repo = releaseRepo(root);
  const a = await packageRelease(repo, '0.1.0', join(root, 'a')),
    b = await packageRelease(repo, '0.2.0', join(root, 'b'));
  expect(
    archiveFiles(readFileSync(a.archive)).get('apps/cli/dist/main.js')?.body.toString(),
  ).not.toContain('sourceMappingURL');
  const prefix = join(root, 'local');
  installArchive(a.archive, a.sha256, prefix);
  // Source is removed: CLI update must use the installed installer.
  rmSync(repo, { recursive: true, force: true });
  for (const artifact of [b, a]) {
    execFileSync(join(prefix, 'bin/ocean'), [
      'install',
      '--archive',
      artifact.archive,
      '--sha256',
      artifact.sha256,
      '--prefix',
      prefix,
    ]);
  }
  expect(readFileSync(join(prefix, 'lib/ocean/current/manifest.json'), 'utf8')).toContain('0.1.0');
});

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FsModule>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});
it('failed durable staging preserves the previous active installation', () => {
  const root = temporary(),
    prefix = join(root, 'local'),
    a = artifact(root),
    b = artifact(root, '0.2.0');
  installArchive(a.path, a.hash, prefix);
  vi.mocked(fsyncSync).mockImplementationOnce(() => {
    throw new Error('disk_failure');
  });
  expect(() => installArchive(b.path, b.hash, prefix)).toThrow('disk_failure');
  expect(readFileSync(join(prefix, 'lib/ocean/current/manifest.json'), 'utf8')).toContain('0.1.0');
});

it('installs exact public program modes under private operator umask', () => {
  const root = temporary(),
    prefix = join(root, 'local'),
    a = artifact(root),
    b = artifact(root, '0.2.0');
  const previous = process.umask(0o077);
  try {
    installArchive(a.path, a.hash, prefix);
    installArchive(a.path, a.hash, prefix);
    installArchive(b.path, b.hash, prefix);
    installArchive(a.path, a.hash, prefix);
    expect(statSync(join(prefix, 'lib/ocean/current/bin/ocean')).mode & 0o777).toBe(0o755);
  } finally {
    process.umask(previous);
  }
});

it('accepts unchanged private modes from earlier installers, but refuses broader permissions', () => {
  const root = temporary(),
    prefix = join(root, 'local'),
    a = artifact(root);
  installArchive(a.path, a.hash, prefix);
  const license = join(prefix, 'lib/ocean/current/LICENSE');
  chmodSync(license, 0o600);
  chmodSync(join(prefix, 'lib/ocean/current/bin/ocean'), 0o700);
  installArchive(a.path, a.hash, prefix);
  expect(statSync(license).mode & 0o777).toBe(0o644);
  chmodSync(license, 0o666);
  expect(() => installArchive(a.path, a.hash, prefix)).toThrow('version_conflict');
});
