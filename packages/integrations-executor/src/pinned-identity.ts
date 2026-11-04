/**
 * Pinned Executor stack identity.
 *
 * The qualified transport is only allowed to dispatch while the installed SDK
 * bundle is the exact patched artifact from the qualification run. Two failure
 * modes are load-bearing:
 *
 * - the patch was never applied (pristine 1.6.11 replays a second business
 *   request after an upstream 401), or
 * - the pin drifted to another version whose bundle differs.
 *
 * Both are detected by hashing the installed chunk file and refusing to enable
 * execution when the digest does not match. The check is asynchronous file I/O
 * and runs once when a transport is opened; the adapter never enables
 * execution speculatively.
 *
 * This module implements the **source/workspace** proof. A packaged release
 * ships a pre-bundled adapter without an SDK `node_modules` tree and uses the
 * build-recorded bundle proof in `bundle-integrity.ts`; `pinned-integrity.ts`
 * selects the layout-specific proof without any caller input.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Exact versions the adapter is qualified against. */
export const PINNED_VERSIONS = {
  sdk: '1.6.11',
  pluginOpenapi: '1.6.11',
  pluginMcp: '1.6.11',
  effect: '4.0.0-beta.59',
  platformNodeShared: '4.0.0-beta.59',
} as const;

/** Published tarball identity for `@executor-js/sdk@1.6.11`. */
export const PINNED_SDK_TARBALL = {
  integrity:
    'sha512-CKdvjdf3zgUiId+gpIxtAFmr6L8lPoIyrp7MoR35MnQhiTI00b+syOxTw8iLXRkMsRM755629dXp/AwPkjv7Jg==',
  shasum: 'f232d29b473b340d2e4b1a3aacdf653f3ace3867',
} as const;

/** The single patched bundle file, package-relative. */
export const PINNED_SDK_CHUNK = 'dist/chunk-Q3W5ARXY.js';

/** sha256 of the chunk after the qualified pnpm patch is applied. */
export const PINNED_SDK_CHUNK_SHA256 =
  '6d3d22c97454dde48daacce07d901b174a642a480efee0b8c73fe31aa6d3a0b9';

/** sha256 of the pristine chunk before the patch (for re-derivation checks). */
export const UNPATCHED_SDK_CHUNK_SHA256 =
  '4fd9504fb58aa5aaf509f1007892550f16a65cc3408948a92c7ad5064685cd82';

/** sha256 of `patches/@executor-js__sdk@1.6.11.patch` (also the lockfile patch_hash). */
export const PINNED_PATCH_SHA256 =
  'e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad';

/** Patch file path, repository-relative. */
export const PINNED_PATCH_FILE = 'patches/@executor-js__sdk@1.6.11.patch';

/** Identities reported by `qualification()`; plain data, no runtime handles. */
export const PINNED_IDENTITIES: Readonly<Record<string, string>> = Object.freeze({
  '@executor-js/sdk': PINNED_VERSIONS.sdk,
  '@executor-js/plugin-openapi': PINNED_VERSIONS.pluginOpenapi,
  '@executor-js/plugin-mcp': PINNED_VERSIONS.pluginMcp,
  effect: PINNED_VERSIONS.effect,
  '@effect/platform-node-shared': PINNED_VERSIONS.platformNodeShared,
  [`@executor-js/sdk#${PINNED_SDK_CHUNK}`]: `sha256:${PINNED_SDK_CHUNK_SHA256}`,
  [`patch#${PINNED_PATCH_FILE}`]: `sha256:${PINNED_PATCH_SHA256}`,
});

export interface InstalledSdkChunkIdentity {
  readonly ok: boolean;
  readonly expectedSha256: string;
  /** Null when the chunk file could not be located/read at all. */
  readonly actualSha256: string | null;
  readonly chunkPath: string | null;
  /** Human-readable reason; never contains file contents. */
  readonly detail: string;
  /** Layout this identity was observed in; absent means `source` for older callers. */
  readonly mode?: 'source' | 'bundle';
  /** Bundle chunk count in bundle mode; null/absent for source layout. */
  readonly bundleFiles?: number | null;
}

export interface VerifyInstalledSdkChunkOptions {
  /** Test seam: hash this file instead of resolving the installed SDK. */
  readonly chunkPath?: string;
  /** Test seam: compare against this digest instead of the pinned one. */
  readonly expectedSha256?: string;
}

/** Resolve candidate paths for the installed SDK chunk, most specific first. */
function chunkCandidates(): readonly string[] {
  const candidates: string[] = [];
  const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve === 'function') {
    try {
      const coreUrl = resolve('@executor-js/sdk/core');
      candidates.push(fileURLToPath(new URL('chunk-Q3W5ARXY.js', coreUrl)));
    } catch {
      // Resolution through the public entry point is best-effort; the layout
      // candidates below cover a direct install without an `import` condition.
    }
  }
  // Both `src/` (tests) and `dist/` (build) sit directly under the package
  // root, so this resolves the package-local dependency link either way.
  const direct = fileURLToPath(
    new URL(`../node_modules/@executor-js/sdk/${PINNED_SDK_CHUNK}`, import.meta.url),
  );
  candidates.push(direct);
  return candidates;
}

async function sha256OfFile(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Hash the installed SDK chunk and compare it with the pinned patched digest.
 * Fails closed: a missing/unreadable chunk is `ok: false`, never an exception
 * that a caller could mistake for "not checked".
 */
export async function verifyInstalledSdkChunk(
  options: Readonly<VerifyInstalledSdkChunkOptions> = {},
): Promise<InstalledSdkChunkIdentity> {
  // `expectedSha256` is an own property; the value may legitimately be an empty
  // string in a negative test, so do not use `??` here.
  const expected =
    options.expectedSha256 === undefined ? PINNED_SDK_CHUNK_SHA256 : options.expectedSha256;
  const paths = options.chunkPath === undefined ? chunkCandidates() : [options.chunkPath];

  for (const candidate of paths) {
    const actual = await sha256OfFile(candidate);
    if (actual === null) continue;
    if (actual === expected) {
      return {
        ok: true,
        expectedSha256: expected,
        actualSha256: actual,
        chunkPath: candidate,
        detail: 'installed Executor SDK chunk matches the pinned patched digest',
        mode: 'source',
        bundleFiles: null,
      };
    }
    return {
      ok: false,
      expectedSha256: expected,
      actualSha256: actual,
      chunkPath: candidate,
      detail: `installed Executor SDK chunk sha256 ${actual} does not match pinned ${expected}`,
      mode: 'source',
      bundleFiles: null,
    };
  }

  return {
    ok: false,
    expectedSha256: expected,
    actualSha256: null,
    chunkPath: options.chunkPath === undefined ? null : options.chunkPath,
    detail: `installed Executor SDK chunk not found (looked for ${PINNED_SDK_CHUNK})`,
    mode: 'source',
    bundleFiles: null,
  };
}
