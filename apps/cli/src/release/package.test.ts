/**
 * Release packaging regressions for the pre-bundled Executor adapter.
 *
 * These are process cases: they run after `pnpm build` and package real built
 * modules with real pinned identities. Assembly-only fixtures use a synthetic
 * adapter entry to keep refusal probes fast; the bundle contents, manifest
 * inventory and determinism checks use the real adapter bundle.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { createArchive } from './archive.js';
import { PINNED_SDK_CHUNK_SHA256, PINNED_PATCH_SHA256 } from './bundle.js';
import { archiveFiles, installArchive, sha256 } from './installer.js';
import { packageRelease } from './package.js';
import {
  addReleaseRepoPackage,
  commitReleaseRepo,
  releaseRepo,
  tamperReleaseRepoPatch,
  workspace,
} from '../../test-fixtures/release-repo.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `ocean-${label}-`));
  roots.push(root);
  return root;
}
const ADAPTER = 'node_modules/@runnets/integrations-executor/';

it('ships the pinned adapter bundle with a verified manifest inventory', async () => {
  const root = temporary('package-bundle');
  const repo = releaseRepo(join(root, 'repo'), { adapter: 'real' });
  const release = await packageRelease(repo, '1.1.0-rc.2', join(root, 'artifact'));
  const files = archiveFiles(readFileSync(release.archive));
  const names = [...files.keys()];
  expect(names.filter((name) => name.endsWith('.map'))).toEqual([]);
  expect(names.filter((name) => name.includes('/node_modules/'))).toEqual([]);
  expect(names.filter((name) => name.includes('node_modules/.pnpm'))).toEqual([]);
  // Test-only compiled helpers never ship, while the product modules beside them do.
  expect(
    readdirSync(join(workspace, 'apps/cli/dist/ocean')).some((name) =>
      /fixture|cleanup/.test(name),
    ),
  ).toBe(true);
  expect(names.filter((name) => /fixture|cleanup/i.test(name))).toEqual([]);
  expect(names).toContain('apps/cli/dist/ocean/coding-project-host.js');
  // Internal planning/session documents stay out of the installed product.
  expect(names.filter((name) => name.startsWith('docs/superpowers/'))).toEqual([]);
  expect(names).toContain('docs/ocean/production.md');
  expect(names).toContain('docs/integration/local-runtime.md');
  // The tsc output of the adapter is replaced by the bundle, never shipped beside it.
  expect(names).not.toContain(ADAPTER + 'dist/transport.js');
  expect(names).toContain(ADAPTER + 'dist/index.js');
  expect(names).toContain(ADAPTER + 'dist/bundle-integrity.json');
  expect(names).toContain(ADAPTER + 'package.json');
  expect(names).toContain(ADAPTER + 'LICENSE');
  expect(names).toContain(ADAPTER + 'THIRD_PARTY_LICENSES/executor-MIT.txt');
  // Only bundled .js chunks ship: the packaged manifest must not advertise d.ts
  // declaration files that the archive does not contain (RC2 final review M8).
  const adapterManifest = JSON.parse(
    files.get(ADAPTER + 'package.json')?.body.toString() ?? '',
  ) as {
    types?: string;
    dependencies?: unknown;
    exports: { '.': { types?: string; import: string } };
  };
  expect(adapterManifest.types).toBeUndefined();
  expect(adapterManifest.exports['.'].types).toBeUndefined();
  expect(adapterManifest.exports['.'].import).toBe('./dist/index.js');
  expect(adapterManifest.dependencies).toBeUndefined();
  const chunks = names.filter((name) => name.startsWith(ADAPTER + 'dist/'));
  expect(chunks.length).toBeGreaterThan(10);
  const manifestBytes = files.get('manifest.json')?.body;
  expect(manifestBytes).toBeDefined();
  const manifest = JSON.parse(manifestBytes?.toString() ?? '') as {
    version: string;
    bundle: {
      adapter: string;
      entry: string;
      integrity: string;
      integritySha256: string;
      files: Record<string, string>;
      identities: Record<string, string>;
    };
  };
  expect(manifest.version).toBe('1.1.0-rc.2');
  expect(manifest.bundle.adapter).toBe('@runnets/integrations-executor');
  expect(manifest.bundle.identities['@executor-js/sdk']).toBe('1.6.11');
  expect(manifest.bundle.identities['@effect/platform-node-shared']).toBe('4.0.0-beta.59');
  expect(manifest.bundle.identities['@executor-js/sdk#dist/chunk-Q3W5ARXY.js']).toBe(
    'sha256:' + PINNED_SDK_CHUNK_SHA256,
  );
  expect(manifest.bundle.identities['patch#patches/@executor-js__sdk@1.6.11.patch']).toBe(
    'sha256:' + PINNED_PATCH_SHA256,
  );
  const integrity = files.get(ADAPTER + manifest.bundle.integrity)?.body;
  expect(integrity).toBeDefined();
  expect(sha256(integrity ?? Buffer.alloc(0))).toBe(manifest.bundle.integritySha256);
  const record = JSON.parse(integrity?.toString() ?? '') as {
    files: Record<string, string>;
    pinnedSdkChunkSha256: string;
    pinnedPatchSha256: string;
    bundler: { name: string; version: string };
  };
  expect(record.pinnedSdkChunkSha256).toBe(PINNED_SDK_CHUNK_SHA256);
  expect(record.pinnedPatchSha256).toBe(PINNED_PATCH_SHA256);
  expect(record.bundler).toEqual({ name: 'rolldown', version: '1.2.16' });
  // The manifest bundle inventory is exactly the integrity inventory plus itself.
  const shipped = Object.keys(manifest.bundle.files).sort();
  expect(shipped).toEqual(
    Object.keys(record.files)
      .map((name) => 'dist/' + name)
      .sort()
      .concat(['dist/bundle-integrity.json'])
      .sort(),
  );
  for (const [name, digest] of Object.entries(manifest.bundle.files)) {
    const body = files.get(ADAPTER + name)?.body;
    expect(sha256(body ?? Buffer.alloc(0)), name).toBe(digest);
  }
  for (const [name, digest] of Object.entries(record.files))
    expect(sha256(files.get(ADAPTER + 'dist/' + name)?.body ?? Buffer.alloc(0)), name).toBe(digest);
  // The CLI package is versioned with the release.
  const cli = JSON.parse(files.get('apps/cli/package.json')?.body.toString() ?? '') as {
    version: string;
  };
  expect(cli.version).toBe('1.1.0-rc.2');
  expect(existsSync(release.archive + '.sha256')).toBe(true);
});

it('produces byte-identical archives and inventory for identical input bytes', async () => {
  const root = temporary('package-determinism');
  const repo = releaseRepo(join(root, 'repo'), { adapter: 'real' });
  const first = await packageRelease(repo, '1.1.0-rc.2', join(root, 'a'));
  const second = await packageRelease(repo, '1.1.0-rc.2', join(root, 'b'));
  expect(second.sha256).toBe(first.sha256);
  expect(second.bundle).toEqual(first.bundle);
  const a = archiveFiles(readFileSync(first.archive)),
    b = archiveFiles(readFileSync(second.archive));
  expect([...a.keys()]).toEqual([...b.keys()]);
  for (const [name, entry] of a)
    expect(sha256(b.get(name)?.body ?? Buffer.alloc(0)), name).toBe(sha256(entry.body));
}, 60_000);

it('still refuses every other unpackaged runtime dependency, producing no archive', async () => {
  const root = temporary('package-allowlist');
  const repo = releaseRepo(join(root, 'repo'));
  addReleaseRepoPackage(repo, 'extra', {
    name: '@runnets/extra',
    version: '0.0.0',
    type: 'module',
    dependencies: { 'left-pad': '1.3.0' },
  });
  writeFileSync(join(repo, 'packages/extra/dist/index.js'), 'export const extra = true;\n');
  commitReleaseRepo(repo, 'add unpackaged dependency');
  const out = join(root, 'artifact');
  await expect(packageRelease(repo, '1.1.0-rc.2', out)).rejects.toThrow(
    'Unpackaged runtime dependency left-pad',
  );
  expect(existsSync(out)).toBe(false);
});

it('refuses to bundle when a pinned identity is deliberately drifted', async () => {
  const root = temporary('package-identity');
  const repo = releaseRepo(join(root, 'repo'));
  tamperReleaseRepoPatch(repo);
  commitReleaseRepo(repo, 'drift the pinned patch');
  const out = join(root, 'artifact');
  await expect(packageRelease(repo, '1.1.0-rc.2', out)).rejects.toThrow(
    'pinned patch identity mismatch',
  );
  expect(existsSync(out)).toBe(false);
});

it('installer refuses a manifest whose recorded bundle integrity disagrees with the shipped bytes', async () => {
  const root = temporary('package-manifest');
  const repo = releaseRepo(join(root, 'repo'), { adapter: 'real' });
  const release = await packageRelease(repo, '1.1.0-rc.2', join(root, 'artifact'));
  const files = archiveFiles(readFileSync(release.archive));
  const target = ADAPTER + 'dist/bundle-integrity.json';
  // Rewrite the integrity file and repair its archive hash, but leave the
  // manifest's recorded bundle digest stale: the installer must refuse.
  const rewritten = Buffer.concat([files.get(target)?.body ?? Buffer.alloc(0), Buffer.from(' ')]);
  expect(rewritten.equals(files.get(target)?.body ?? Buffer.alloc(0))).toBe(false);
  files.set(target, { body: rewritten, mode: 0o644 });
  const manifest = JSON.parse(files.get('manifest.json')?.body.toString() ?? '') as {
    files: Record<string, { sha256: string; mode: number }>;
  };
  manifest.files[target] = { sha256: sha256(rewritten), mode: 0o644 };
  files.set('manifest.json', {
    body: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    mode: 0o644,
  });
  const bytes = createArchive(files);
  const archive = join(root, 'tampered.tar.gz');
  writeFileSync(archive, bytes);
  expect(() => installArchive(archive, sha256(bytes), join(root, 'local'))).toThrow(
    'invalid_manifest',
  );
  expect(existsSync(join(root, 'local'))).toBe(false);
});

it('records the release revision and lockfile identity from the committed tree', async () => {
  const root = temporary('package-revision');
  const repo = releaseRepo(join(root, 'repo'), { adapter: 'real' });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  const release = await packageRelease(repo, '1.1.0-rc.2', join(root, 'artifact'));
  const manifest = JSON.parse(
    archiveFiles(readFileSync(release.archive)).get('manifest.json')?.body.toString() ?? '',
  ) as { revision: string; lockfileSha256: string };
  expect(manifest.revision).toBe(revision);
  expect(manifest.lockfileSha256).toBe(sha256(readFileSync(join(workspace, 'pnpm-lock.yaml'))));
});
