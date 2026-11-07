/** Structural installer compatibility only: these archives contain no historical SDK/runtime. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createArchive } from './archive.js';
import { installArchive, sha256, type ReleaseManifest } from './installer.js';
import { packageRelease } from './package.js';
import { releaseRepo } from '../../test-fixtures/release-repo.js';

const base = 'node_modules/@runnets/integrations-executor/';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'historical-structural-'));
  roots.push(root);
  return root;
}
function historical(version = '1.1.0-rc.2') {
  const files = new Map<string, { body: Buffer; mode: number }>();
  const add = (name: string, body: string) =>
    files.set(name, { body: Buffer.from(body), mode: 0o644 });
  for (const name of ['bin/ocean', 'apps/cli/dist/main.js', 'LICENSE', 'NOTICE', 'package.json'])
    add(name, 'structural fixture\n');
  add(base + 'package.json', '{"type":"module"}');
  add(base + 'LICENSE', 'Structural fixture: no vendor code\n');
  add(base + 'dist/index.js', 'export const structuralFixture = true;\n');
  add(base + 'dist/chunk-fixture.js', 'export const chunk = true;\n');
  const chunks = Object.fromEntries(
    [...files]
      .filter(([n]) => n.startsWith(base + 'dist/'))
      .map(([n, f]) => [n.slice(base.length), sha256(f.body)]),
  );
  add(base + 'dist/bundle-integrity.json', JSON.stringify({ format: 1, files: chunks }));
  const manifest = {
    format: 1 as const,
    version,
    revision: 'a'.repeat(40),
    node: process.version,
    platform: 'linux',
    arch: 'x64',
    lockfileSha256: 'b'.repeat(64),
    files: {} as Record<string, { sha256: string; mode: number }>,
    bundle: {
      adapter: '@runnets/integrations-executor',
      entry: 'dist/index.js',
      integrity: 'dist/bundle-integrity.json',
      integritySha256: sha256(files.get(base + 'dist/bundle-integrity.json')!.body),
      files: {
        ...chunks,
        'dist/bundle-integrity.json': sha256(files.get(base + 'dist/bundle-integrity.json')!.body),
      } as Record<string, string>,
      identities: { '@executor-js/sdk': '1.6.11' } as Record<string, string>,
    },
  } satisfies ReleaseManifest;
  return { files, manifest };
}
function archive(root: string, fixture = historical(), repairInventory = true) {
  if (repairInventory)
    fixture.manifest.files = Object.fromEntries(
      [...fixture.files]
        .filter(([name]) => name !== 'manifest.json')
        .map(([name, file]) => [name, { sha256: sha256(file.body), mode: file.mode }]),
    );
  fixture.files.set('manifest.json', {
    body: Buffer.from(JSON.stringify(fixture.manifest)),
    mode: 0o644,
  });
  const bytes = createArchive(fixture.files),
    path = join(root, fixture.manifest.version + '.tar.gz');
  writeFileSync(path, bytes);
  return { path, checksum: sha256(bytes) };
}
it('accepts historical structure, repeats, upgrades and rolls back; installed tampering refuses', () => {
  const root = temporary(),
    prefix = join(root, 'prefix');
  const first = archive(root),
    second = archive(root, historical('1.1.0-structural'));
  for (const input of [first, first, second, first])
    expect(installArchive(input.path, input.checksum, prefix).bundle?.adapter).toBe(
      '@runnets/integrations-executor',
    );
  expect(readFileSync(join(prefix, 'lib/ocean/current/manifest.json'), 'utf8')).toContain(
    '1.1.0-rc.2',
  );
  writeFileSync(join(prefix, 'lib/ocean/current', base, 'dist/chunk-fixture.js'), 'tampered');
  expect(() => installArchive(first.path, first.checksum, prefix)).toThrow('version_conflict');
});
it.each([
  'adapter',
  'entry',
  'integrity-path',
  'integrity-hash',
  'missing-integrity',
  'missing-license',
  'missing-package',
  'identity',
  'entry-inventory',
  'chunk-hash',
  'mode',
])('retains existing historical manifest/hash refusal: %s', (mode) => {
  const root = temporary(),
    fixture = historical(),
    b = fixture.manifest.bundle!;
  archive(root, fixture);
  if (mode === 'adapter') b.adapter = '@runnets/other';
  if (mode === 'entry') b.entry = 'dist/other.js';
  if (mode === 'integrity-path') b.integrity = 'dist/other.json';
  if (mode === 'integrity-hash') b.integritySha256 = '0'.repeat(64);
  if (mode.startsWith('missing-'))
    fixture.files.delete(
      base +
        {
          'missing-integrity': b.integrity,
          'missing-license': 'LICENSE',
          'missing-package': 'package.json',
        }[mode]!,
    );
  if (mode === 'identity') delete b.identities['@executor-js/sdk'];
  if (mode === 'entry-inventory') delete b.files[b.entry];
  if (mode === 'chunk-hash')
    fixture.files.get(base + 'dist/chunk-fixture.js')!.body = Buffer.from('tampered');
  if (mode === 'mode') fixture.files.get(base + 'dist/chunk-fixture.js')!.mode = 0o755;
  const input = archive(root, fixture, !['chunk-hash', 'mode'].includes(mode)),
    prefix = join(root, 'prefix');
  expect(() => installArchive(input.path, input.checksum, prefix)).toThrow('invalid_manifest');
  expect(existsSync(prefix)).toBe(false);
});
it('emitted current standalone installer accepts historical structure and rejects a stale integrity digest', async () => {
  const root = temporary();
  await packageRelease(
    releaseRepo(join(root, 'repo'), { adapter: 'synthetic' }),
    '1.1.0-structural',
    join(root, 'package'),
  );
  const fixture = historical(),
    good = archive(root, fixture),
    prefix = join(root, 'prefix');
  const run = (path: string, checksum: string, target: string) =>
    execFileSync(
      process.execPath,
      [
        join(root, 'package/ocean-install.mjs'),
        '--archive',
        path,
        '--sha256',
        checksum,
        '--prefix',
        target,
      ],
      { stdio: 'pipe' },
    );
  expect(JSON.parse(run(good.path, good.checksum, prefix).toString()).version).toBe('1.1.0-rc.2');
  fixture.files.get(base + fixture.manifest.bundle!.integrity)!.body = Buffer.from('{}');
  const bad = archive(root, fixture),
    refused = join(root, 'refused');
  expect(() => run(bad.path, bad.checksum, refused)).toThrow();
  expect(existsSync(refused)).toBe(false);
});
