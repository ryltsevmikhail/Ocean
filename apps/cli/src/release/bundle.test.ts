/**
 * Deterministic adapter bundling and the packaged-bundle integrity gate.
 *
 * The bundle is built from the real patched SDK and then loaded from a
 * disposable installed layout (the way the release archive ships it). The child
 * process proves that execution stays disabled by default and qualifies only
 * with the build-recorded chunk inventory; tampering is refused closed.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ADAPTER_ENTRY,
  ADAPTER_INTEGRITY_FILE,
  assertPinnedBuildIdentities,
  buildAdapterBundle,
  PINNED_PATCH_SHA256,
  PINNED_SDK_CHUNK_SHA256,
  type AdapterBundle,
} from './legacy-bundle.js';
import { workspace } from '../../test-fixtures/release-repo.js';

let bundle: AdapterBundle;
let again: AdapterBundle;
const roots: string[] = [];

beforeAll(async () => {
  bundle = await buildAdapterBundle(workspace);
  again = await buildAdapterBundle(workspace);
}, 120_000);
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Lay out the bundle exactly like the release archive ships it. */
function installedLayout(): { root: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'ocean-bundle-layout-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/@runnets'), { recursive: true });
  for (const name of readdirSync(join(workspace, 'packages')))
    if (name !== 'integrations-executor')
      symlinkSync(join(workspace, 'packages', name), join(root, 'node_modules/@runnets', name));
  const adapter = join(root, 'node_modules/@runnets/integrations-executor');
  mkdirSync(join(adapter, 'dist'), { recursive: true });
  for (const [path, body] of bundle.files) writeFileSync(join(adapter, path), body);
  writeFileSync(
    join(adapter, 'package.json'),
    JSON.stringify({
      name: '@runnets/integrations-executor',
      version: '1.1.0-rc.2',
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { import: './dist/index.js' } },
      license: 'Apache-2.0',
    }),
  );
  writeFileSync(join(adapter, 'LICENSE'), 'Apache-2.0 fixture\n');
  return { root, entry: join(adapter, ADAPTER_ENTRY) };
}

const probe = `
const entry = process.argv[1];
const m = await import(entry);
const base = { tenantId: 'probe-tenant', subjectId: 'probe-subject', allowedOrigins: ['http://127.0.0.1:1'] };
const refused = await m.ExecutorServicePluginTransport.open(base).then(() => 'opened').catch((e) => e.reason);
let qualified = null;
try {
  const transport = await m.ExecutorServicePluginTransport.open({ ...base, enableExecution: true });
  const status = transport.qualification();
  qualified = { ok: status.qualified, mode: status.integrityMode, chunks: status.bundleFileCount, digest: transport.status().installedChunkSha256 };
  await transport.close();
} catch (e) {
  qualified = { refused: e.reason };
}
console.log(JSON.stringify({ exports: Object.keys(m).sort(), refused, qualified }));
`;
function runProbe(entry: string): {
  exports: string[];
  refused: string;
  qualified: { ok?: boolean; mode?: string; chunks?: number; digest?: string; refused?: string };
} {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', probe, entry], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  return JSON.parse(output.trim()) as ReturnType<typeof runProbe>;
}

it('asserts every pinned identity and bundles the pinned dependency tree', () => {
  const pins = assertPinnedBuildIdentities(workspace);
  expect(pins.identities['@executor-js/sdk']).toBe('1.6.11');
  expect(pins.identities['@executor-js/plugin-openapi']).toBe('1.6.11');
  expect(pins.identities['@executor-js/plugin-mcp']).toBe('1.6.11');
  expect(pins.identities['effect']).toBe('4.0.0-beta.59');
  expect(pins.identities['@effect/platform-node-shared']).toBe('4.0.0-beta.59');
  expect(pins.identities['@executor-js/sdk#dist/chunk-Q3W5ARXY.js']).toBe(
    'sha256:' + PINNED_SDK_CHUNK_SHA256,
  );
  expect(pins.identities['patch#patches/@executor-js__sdk@1.6.11.patch']).toBe(
    'sha256:' + PINNED_PATCH_SHA256,
  );
  expect(pins.patchHashRecords).toBe(5);
  expect(bundle.chunks).toBeGreaterThanOrEqual(10);
  expect(bundle.bytes).toBeGreaterThan(1_000_000);
  expect([...bundle.files.keys()]).toContain('dist/index.js');
  expect([...bundle.files.keys()].some((name) => name.endsWith('.map'))).toBe(false);
  expect([...bundle.files.keys()]).toContain('dist/' + ADAPTER_INTEGRITY_FILE);
});

it('refuses a lockfile with missing, extra or malformed patch_hash identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-pins-'));
  roots.push(root);
  mkdirSync(join(root, 'patches'), { recursive: true });
  copyFileSync(
    join(workspace, 'patches', '@executor-js__sdk@1.6.11.patch'),
    join(root, 'patches', '@executor-js__sdk@1.6.11.patch'),
  );
  const lockfile = (records: readonly string[]) =>
    writeFileSync(join(root, 'pnpm-lock.yaml'), records.join('\n') + '\n');
  const pinned = (count: number) =>
    Array.from({ length: count }, () => 'patch_hash=' + PINNED_PATCH_SHA256);
  lockfile([]);
  expect(() => assertPinnedBuildIdentities(root)).toThrow('exactly 5 patch_hash');
  lockfile(pinned(4));
  expect(() => assertPinnedBuildIdentities(root)).toThrow('exactly 5 patch_hash');
  lockfile([...pinned(5), 'patch_hash=' + PINNED_PATCH_SHA256]);
  expect(() => assertPinnedBuildIdentities(root)).toThrow('exactly 5 patch_hash');
  lockfile([...pinned(4), 'patch_hash=zzz']);
  expect(() => assertPinnedBuildIdentities(root)).toThrow('malformed patch_hash');
  lockfile([...pinned(4), 'patch_hash=' + PINNED_PATCH_SHA256 + 'garbage']);
  expect(() => assertPinnedBuildIdentities(root)).toThrow('malformed patch_hash');
  lockfile([...pinned(4), 'patch_hash=' + '0'.repeat(64)]);
  expect(() => assertPinnedBuildIdentities(root)).toThrow('patch_hash identity mismatch');
});

it('is deterministic: same input bytes produce the same chunk inventory and digests', () => {
  expect(again.filesSha256).toEqual(bundle.filesSha256);
  expect(again.integritySha256).toBe(bundle.integritySha256);
  expect(again.chunks).toBe(bundle.chunks);
  expect(again.bytes).toBe(bundle.bytes);
  const record = JSON.parse(
    bundle.files.get('dist/' + ADAPTER_INTEGRITY_FILE)?.toString() ?? '',
  ) as {
    files: Record<string, string>;
    pinnedSdkChunkSha256: string;
    pinnedPatchSha256: string;
  };
  for (const [name, digest] of Object.entries(record.files))
    expect(digest, name).toBe(bundle.filesSha256['dist/' + name]);
  expect(record.pinnedSdkChunkSha256).toBe(PINNED_SDK_CHUNK_SHA256);
  expect(record.pinnedPatchSha256).toBe(PINNED_PATCH_SHA256);
});

it('the installed bundle qualifies through the packaged proof, disabled by default', () => {
  const layout = installedLayout();
  const result = runProbe(layout.entry);
  expect(result.exports).toEqual([
    'ExecutorPluginSetup',
    'ExecutorServicePluginTransport',
    'ExecutorSetupError',
    'ExecutorTransportOpenError',
    'PINNED_IDENTITIES',
  ]);
  expect(result.refused).toBe('execution_not_enabled');
  expect(result.qualified).toEqual({
    ok: true,
    mode: 'bundle',
    chunks: bundle.chunks,
    digest: PINNED_SDK_CHUNK_SHA256,
  });
});

it('refuses a tampered chunk and a missing integrity record, failing closed', () => {
  const tampered = installedLayout();
  const chunk = join(tampered.root, 'node_modules/@runnets/integrations-executor/dist/index.js');
  // Append bytes so the adapter code still loads; the integrity gate must refuse.
  writeFileSync(chunk, '\n// tampered\n', { flag: 'a' });
  const tamperedResult = runProbe(tampered.entry);
  expect(tamperedResult.qualified).toMatchObject({ refused: 'bundle_integrity_mismatch' });

  const missing = installedLayout();
  rmSync(
    join(
      missing.root,
      'node_modules/@runnets/integrations-executor/dist/' + ADAPTER_INTEGRITY_FILE,
    ),
  );
  const missingResult = runProbe(missing.entry);
  expect(missingResult.refused).toBe('execution_not_enabled');
  expect(missingResult.qualified).toMatchObject({ refused: 'pinned_chunk_unreadable' });
});
