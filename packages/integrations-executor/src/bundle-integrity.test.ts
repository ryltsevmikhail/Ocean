/**
 * Packaged-bundle integrity proof tests.
 *
 * The proof must be fail-closed for every corruption shape and must never
 * accept a caller-supplied identity. Bundle-mode selection itself is exercised
 * end-to-end by `apps/cli/src/release/bundle.test.ts` (real rolldown output
 * loaded from a temp installed layout); these tests drive the verifier over
 * crafted directories.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  BUNDLE_INTEGRITY_FILE,
  BUNDLE_INTEGRITY_FORMAT,
  verifyBundleDirectory,
  verifyBundledAdapter,
} from './bundle-integrity.js';
import {
  PINNED_PATCH_SHA256,
  PINNED_SDK_CHUNK_SHA256,
  PINNED_VERSIONS,
} from './pinned-identity.js';
import { verifyPinnedIntegrity } from './pinned-integrity.js';
import { assessQualification } from './status.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(chunks: Record<string, string> = { 'index.js': 'entry', 'chunk-a.js': 'a' }) {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-bundle-integrity-'));
  roots.push(directory);
  mkdirSync(directory, { recursive: true });
  for (const [name, body] of Object.entries(chunks)) writeFileSync(join(directory, name), body);
  const record = {
    format: BUNDLE_INTEGRITY_FORMAT,
    pinnedVersions: PINNED_VERSIONS,
    pinnedSdkChunkSha256: PINNED_SDK_CHUNK_SHA256,
    pinnedPatchSha256: PINNED_PATCH_SHA256,
    bundler: { name: 'rolldown', version: '1.2.16' },
    files: Object.fromEntries(Object.entries(chunks).map(([name, body]) => [name, sha256(body)])),
  };
  writeFileSync(join(directory, BUNDLE_INTEGRITY_FILE), JSON.stringify(record, null, 2) + '\n');
  return { directory, record };
}

it('qualifies an intact packaged bundle and reports bundle-mode facts', async () => {
  const { directory } = fixture();
  const identity = await verifyBundleDirectory(directory);
  expect(identity).toMatchObject({
    ok: true,
    mode: 'bundle',
    expectedSha256: PINNED_SDK_CHUNK_SHA256,
    actualSha256: PINNED_SDK_CHUNK_SHA256,
    bundleFiles: 2,
  });
  expect(identity.chunkPath).toBe(join(directory, 'index.js'));
});

it('refuses a missing integrity record, invalid JSON and non-bundle layouts distinctly', async () => {
  const { directory } = fixture();
  const withoutRecord = mkdtempSync(join(tmpdir(), 'ocean-bundle-integrity-'));
  roots.push(withoutRecord);
  writeFileSync(join(withoutRecord, 'index.js'), 'entry');
  expect(await verifyBundleDirectory(withoutRecord)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('unreadable') as string,
  });
  writeFileSync(join(directory, BUNDLE_INTEGRITY_FILE), '{not json');
  expect(await verifyBundleDirectory(directory)).toMatchObject({
    ok: false,
    detail: 'bundle integrity record is not valid JSON',
  });
});

it('refuses drifted pins, a mutated chunk, an extra chunk and a missing chunk', async () => {
  const drift = fixture();
  writeFileSync(
    join(drift.directory, BUNDLE_INTEGRITY_FILE),
    JSON.stringify({ ...drift.record, pinnedSdkChunkSha256: '0'.repeat(64) }, null, 2),
  );
  expect(await verifyBundleDirectory(drift.directory)).toMatchObject({
    ok: false,
    actualSha256: null,
  });

  const versionDrift = fixture();
  writeFileSync(
    join(versionDrift.directory, BUNDLE_INTEGRITY_FILE),
    JSON.stringify(
      {
        ...versionDrift.record,
        pinnedVersions: { ...PINNED_VERSIONS, effect: '4.0.0-beta.60' },
      },
      null,
      2,
    ),
  );
  expect(await verifyBundleDirectory(versionDrift.directory)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('effect') as string,
  });

  const mutated = fixture();
  writeFileSync(join(mutated.directory, 'index.js'), 'entry-mutated');
  expect(await verifyBundleDirectory(mutated.directory)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('index.js sha256') as string,
  });

  const extra = fixture();
  writeFileSync(join(extra.directory, 'chunk-b.js'), 'b');
  expect(await verifyBundleDirectory(extra.directory)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('chunk set differs') as string,
  });

  const missing = fixture();
  rmSync(join(missing.directory, 'chunk-a.js'));
  expect(await verifyBundleDirectory(missing.directory)).toMatchObject({
    ok: false,
    detail: expect.stringContaining('chunk set differs') as string,
  });
});

it('source runs keep the installed-chunk proof and select it by layout, not by caller input', async () => {
  expect(await verifyBundledAdapter()).toBeNull();
  const identity = await verifyPinnedIntegrity();
  expect(identity).toMatchObject({ ok: true, mode: 'source' });
  expect(identity.actualSha256).toBe(PINNED_SDK_CHUNK_SHA256);
  expect(identity.bundleFiles).toBeNull();
});

it('bundle failures map to bundle-specific reasons and a verified bundle qualifies', () => {
  const base = {
    expectedSha256: PINNED_SDK_CHUNK_SHA256,
    chunkPath: null,
    detail: 'probe',
    mode: 'bundle' as const,
    bundleFiles: 2,
  };
  expect(
    assessQualification({ requested: true, identity: { ...base, ok: false, actualSha256: null } })
      .reason,
  ).toBe('bundle_integrity_unreadable');
  expect(
    assessQualification({
      requested: true,
      identity: { ...base, ok: false, actualSha256: PINNED_SDK_CHUNK_SHA256 },
    }).reason,
  ).toBe('bundle_integrity_mismatch');
  expect(
    assessQualification({
      requested: true,
      identity: { ...base, ok: true, actualSha256: PINNED_SDK_CHUNK_SHA256 },
    }),
  ).toMatchObject({ qualified: true, reason: null, integrityMode: 'bundle', bundleFileCount: 2 });
  expect(
    assessQualification({ requested: false, identity: { ...base, ok: false, actualSha256: null } })
      .reason,
  ).toBe('execution_not_enabled');
});
