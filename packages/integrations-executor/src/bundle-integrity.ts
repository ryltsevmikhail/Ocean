/**
 * Packaged-bundle integrity proof.
 *
 * A release archive does not ship the Executor SDK's `node_modules` tree: the
 * adapter is pre-bundled by `apps/cli/src/release/bundle.ts` and shipped as
 * `node_modules/@runnets/integrations-executor/dist/**`. `verifyInstalledSdkChunk`
 * therefore cannot find the SDK chunk in that layout, so this module provides
 * the equivalent fail-closed proof for bundled mode.
 *
 * What is verified here
 * - `bundle-integrity.json` next to the emitted chunks must exist and parse as
 *   format 1 with the exact pinned versions, SDK chunk digest and patch digest
 *   that the adapter itself pins.
 * - The set of `.js` files next to the integrity file must equal the recorded
 *   set exactly, and every file's bytes must hash to the recorded SHA-256.
 *
 * What anchors the integrity file: it is produced only by the verified build
 * (after `assertPinnedBuildIdentities`), is listed in the release manifest and
 * therefore covered by the installer-verified archive SHA-256. The expected
 * digests are never supplied by a caller: no option seam exists, the public
 * entry point exposes no way to inject an identity, and a missing/unreadable/
 * mismatching proof is always a refusal (`ok: false`), never "not checked".
 *
 * Source/workspace runs keep verifying the installed SDK chunk bytes; see
 * `pinned-identity.ts` and `pinned-integrity.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_PATCH_SHA256,
  PINNED_SDK_CHUNK_SHA256,
  PINNED_VERSIONS,
  type InstalledSdkChunkIdentity,
} from './pinned-identity.js';

/** Integrity record emitted by the verified release build. */
export const BUNDLE_INTEGRITY_FILE = 'bundle-integrity.json';

/** Integrity record format this adapter understands. */
export const BUNDLE_INTEGRITY_FORMAT = 1;

export interface BundleIntegrityRecord {
  readonly format: 1;
  readonly pinnedVersions: Readonly<Record<string, string>>;
  readonly pinnedSdkChunkSha256: string;
  readonly pinnedPatchSha256: string;
  readonly bundler: { readonly name: string; readonly version: string };
  /** Bundle-relative chunk file name -> SHA-256 of its bytes. */
  readonly files: Readonly<Record<string, string>>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CHUNK_FILE = /^[A-Za-z0-9._-]+\.js$/;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function refusal(
  detail: string,
  actualSha256: string | null = null,
  bundleFiles: number | null = null,
): InstalledSdkChunkIdentity {
  return {
    ok: false,
    expectedSha256: PINNED_SDK_CHUNK_SHA256,
    actualSha256,
    chunkPath: null,
    detail,
    mode: 'bundle',
    bundleFiles,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exact-match the pinned versions against the in-code pin. */
function pinsMatch(record: Record<string, unknown>): string | null {
  for (const [name, version] of Object.entries(PINNED_VERSIONS))
    if (record[name] !== version) return `recorded pin for ${name} is not the adapter's pin`;
  if (Object.keys(record).length !== Object.keys(PINNED_VERSIONS).length)
    return 'recorded pinned versions do not match the adapter pin set';
  return null;
}

/** Validate the parsed integrity record shape and pinned identities. */
function validateRecord(value: unknown): BundleIntegrityRecord | string {
  if (!isRecord(value)) return 'bundle integrity record is not an object';
  if (value['format'] !== BUNDLE_INTEGRITY_FORMAT)
    return `unsupported bundle integrity format ${String(value['format'])}`;
  const versions = value['pinnedVersions'];
  if (!isRecord(versions)) return 'bundle integrity record has no pinned versions';
  const versionProblem = pinsMatch(versions);
  if (versionProblem !== null) return versionProblem;
  if (value['pinnedSdkChunkSha256'] !== PINNED_SDK_CHUNK_SHA256)
    return 'bundle integrity record does not pin the qualified SDK chunk digest';
  if (value['pinnedPatchSha256'] !== PINNED_PATCH_SHA256)
    return 'bundle integrity record does not pin the qualified patch digest';
  const bundler = value['bundler'];
  if (
    !isRecord(bundler) ||
    typeof bundler['name'] !== 'string' ||
    bundler['name'] === '' ||
    typeof bundler['version'] !== 'string'
  )
    return 'bundle integrity record has no bundler identity';
  const files = value['files'];
  if (!isRecord(files) || Object.keys(files).length === 0)
    return 'bundle integrity record has no files';
  for (const [name, digest] of Object.entries(files))
    if (!CHUNK_FILE.test(name) || typeof digest !== 'string' || !SHA256_HEX.test(digest))
      return `bundle integrity record has an invalid entry: ${name}`;
  if (!('index.js' in files)) return 'bundle integrity record does not list the entry chunk';
  return {
    format: BUNDLE_INTEGRITY_FORMAT,
    pinnedVersions: versions as Readonly<Record<string, string>>,
    pinnedSdkChunkSha256: PINNED_SDK_CHUNK_SHA256,
    pinnedPatchSha256: PINNED_PATCH_SHA256,
    bundler: { name: String(bundler['name']), version: String(bundler['version']) },
    files: files as Readonly<Record<string, string>>,
  };
}

/**
 * Verify one bundle directory. Exported for the regression tests only; product
 * admission reaches it through `verifyBundledAdapter` with its own directory.
 */
export async function verifyBundleDirectory(directory: string): Promise<InstalledSdkChunkIdentity> {
  let raw: string;
  try {
    raw = await readFile(join(directory, BUNDLE_INTEGRITY_FILE), 'utf8');
  } catch {
    return refusal(`bundle integrity record ${BUNDLE_INTEGRITY_FILE} is unreadable`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return refusal('bundle integrity record is not valid JSON');
  }
  const record = validateRecord(parsed);
  if (typeof record === 'string') return refusal(record);
  const recorded = Object.keys(record.files).sort();
  const present = readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort();
  if (recorded.length !== present.length)
    return refusal(
      `bundled adapter chunk set differs from the build-recorded inventory (${present.length} present, ${recorded.length} recorded)`,
      record.pinnedSdkChunkSha256,
      present.length,
    );
  for (const [at, name] of present.entries())
    if (name !== recorded[at])
      return refusal(
        `bundled adapter chunk ${name} is not part of the build-recorded inventory`,
        record.pinnedSdkChunkSha256,
        present.length,
      );
  for (const name of present) {
    const digest = record.files[name];
    let actual: string;
    try {
      actual = sha256(await readFile(join(directory, name)));
    } catch {
      return refusal(`bundled adapter chunk ${name} is unreadable`);
    }
    if (actual !== digest)
      return refusal(
        `bundled adapter chunk ${name} sha256 ${actual} does not match recorded ${digest}`,
        record.pinnedSdkChunkSha256,
        present.length,
      );
  }
  return {
    ok: true,
    expectedSha256: PINNED_SDK_CHUNK_SHA256,
    actualSha256: record.pinnedSdkChunkSha256,
    chunkPath: join(directory, 'index.js'),
    detail: `packaged Executor adapter bundle matches the build-recorded digests (${present.length} chunks)`,
    mode: 'bundle',
    bundleFiles: present.length,
  };
}

/**
 * Detect and verify the packaged bundle layout.
 *
 * Returns `null` when this module was loaded from source/tsc output (no
 * integrity file next to it), so the caller can fall back to the installed-SDK
 * chunk proof. Any integrity file that is present but bad is a refusal.
 */
export async function verifyBundledAdapter(): Promise<InstalledSdkChunkIdentity | null> {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  if (!existsSync(join(directory, BUNDLE_INTEGRITY_FILE))) return null;
  return verifyBundleDirectory(directory);
}
