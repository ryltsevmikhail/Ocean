/**
 * Deterministic packaging of the pinned Executor adapter.
 *
 * The release archive cannot ship `node_modules`: the adapter's Executor/Effect
 * dependency tree is pre-bundled with rolldown into code-split ESM chunks. Before
 * a single byte is emitted, the build asserts the exact identities the adapter
 * pins (patched SDK chunk, patch digest, lockfile `patch_hash`, plugin/effect
 * versions and bundler version) and refuses on any drift. It then fails closed
 * on unresolved external imports, missing pinned modules, emitted assets or
 * source maps, so the shipped `dist/**` is hermetic and reproducible.
 *
 * The build also emits `bundle-integrity.json`, the chunk digest inventory the
 * installed adapter verifies at admission (see
 * `packages/integrations-executor/src/bundle-integrity.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { rolldown } from 'rolldown';

import { sha256 } from './installer.js';

/** Release-relative locations of the packaged adapter. */
export const ADAPTER_PACKAGE = '@runnets/integrations-executor';
export const ADAPTER_SOURCE_DIR = 'packages/integrations-executor';
export const ADAPTER_ENTRY = 'dist/index.js';
export const ADAPTER_INTEGRITY_FILE = 'bundle-integrity.json';
export const ADAPTER_INTEGRITY_FORMAT = 1;

/** Pinned versions asserted before bundling. */
export const PINNED_VERSIONS = {
  sdk: '1.6.11',
  pluginOpenapi: '1.6.11',
  pluginMcp: '1.6.11',
  effect: '4.0.0-beta.59',
  platformNodeShared: '4.0.0-beta.59',
} as const;

export const PINNED_SDK_CHUNK = 'dist/chunk-Q3W5ARXY.js';
export const PINNED_SDK_CHUNK_SHA256 =
  '6d3d22c97454dde48daacce07d901b174a642a480efee0b8c73fe31aa6d3a0b9';
export const PINNED_PATCH_FILE = 'patches/@executor-js__sdk@1.6.11.patch';
export const PINNED_PATCH_SHA256 =
  'e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad';
/** The lockfile must carry exactly this many `patch_hash` records for the pinned patch. */
export const PINNED_PATCH_HASH_RECORDS = 5;

/** The only external dependencies the bundled adapter may declare. */
export const ADAPTER_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@effect/platform-node-shared': PINNED_VERSIONS.platformNodeShared,
  '@executor-js/plugin-mcp': PINNED_VERSIONS.pluginMcp,
  '@executor-js/plugin-openapi': PINNED_VERSIONS.pluginOpenapi,
  '@executor-js/sdk': PINNED_VERSIONS.sdk,
  '@runnets/application': 'workspace:*',
  effect: PINNED_VERSIONS.effect,
};

/** Pinned bundler; the record proves which tool produced the chunks. */
export const BUNDLER = { name: 'rolldown', version: '1.2.16' } as const;

/** Versions of packages the release must resolve to the pinned identities. */
const RESOLVED_PACKAGES = {
  sdk: ['@executor-js/sdk', PINNED_VERSIONS.sdk],
  pluginOpenapi: ['@executor-js/plugin-openapi', PINNED_VERSIONS.pluginOpenapi],
  pluginMcp: ['@executor-js/plugin-mcp', PINNED_VERSIONS.pluginMcp],
  effect: ['effect', PINNED_VERSIONS.effect],
  platformNodeShared: ['@effect/platform-node-shared', PINNED_VERSIONS.platformNodeShared],
} as const;

/** The packaged bundle's chunk files and the identity table recorded in the manifest. */
export interface AdapterBundle {
  /** Package-relative path (`dist/...`) -> bytes. */
  readonly files: ReadonlyMap<string, Buffer>;
  /** Package-relative path -> SHA-256 of the bytes. */
  readonly filesSha256: Readonly<Record<string, string>>;
  readonly integritySha256: string;
  /** Pinned identity table for the release manifest. */
  readonly identities: Readonly<Record<string, string>>;
  readonly chunks: number;
  readonly bytes: number;
}

export interface ReleasePins {
  readonly identities: Readonly<Record<string, string>>;
  readonly patchHashRecords: number;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function packageVersion(directory: string, name: string): string {
  const version = readJson(join(directory, 'package.json'))['version'];
  if (typeof version !== 'string' || version === '')
    throw new Error(`pinned dependency ${name} has no version`);
  return version;
}

function fileDigest(path: string, what: string): string {
  if (!existsSync(path)) throw new Error(`pinned ${what} is missing: ${path}`);
  return sha256(readFileSync(path));
}

/**
 * Fail closed unless the installed tree and repository state are the exact
 * identities the qualified adapter pins. Returns the identity table that the
 * release manifest records.
 */
export function assertPinnedBuildIdentities(root: string): ReleasePins {
  const patchDigest = fileDigest(join(root, PINNED_PATCH_FILE), 'SDK patch file');
  if (patchDigest !== PINNED_PATCH_SHA256)
    throw new Error(
      `pinned patch identity mismatch: expected ${PINNED_PATCH_SHA256}, observed ${patchDigest}`,
    );
  const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  // Capture the complete value to a delimiter, so a truncated/extra-suffixed
  // identity cannot silently match the pinned prefix.
  const patchHashes = [...lockfile.matchAll(/patch_hash=([^\s,)&]+)/g)].map(
    (match) => match[1] ?? '',
  );
  if (patchHashes.length !== PINNED_PATCH_HASH_RECORDS)
    throw new Error(
      `lockfile must record exactly ${PINNED_PATCH_HASH_RECORDS} patch_hash identities for the Executor SDK patch; observed ${patchHashes.length}`,
    );
  for (const hash of patchHashes)
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error(`lockfile recorded a malformed patch_hash identity: ${hash}`);
  const driftedHash = patchHashes.find((hash) => hash !== PINNED_PATCH_SHA256);
  if (driftedHash !== undefined)
    throw new Error(
      `lockfile patch_hash identity mismatch: expected ${PINNED_PATCH_SHA256}, observed ${driftedHash}`,
    );
  const nodeModules = join(root, ADAPTER_SOURCE_DIR, 'node_modules');
  const chunkDigest = fileDigest(
    join(nodeModules, '@executor-js/sdk', PINNED_SDK_CHUNK),
    'installed Executor SDK chunk',
  );
  if (chunkDigest !== PINNED_SDK_CHUNK_SHA256)
    throw new Error(
      `installed Executor SDK chunk identity mismatch: expected ${PINNED_SDK_CHUNK_SHA256}, observed ${chunkDigest}`,
    );
  for (const [pin, entry] of Object.entries(RESOLVED_PACKAGES)) {
    const [name, expected] = entry;
    const actual = packageVersion(join(nodeModules, name), name);
    if (actual !== expected)
      throw new Error(
        `pinned version mismatch for ${pin}: expected ${expected}, observed ${actual}`,
      );
  }
  const adapter = jsonObject(readJson(join(root, ADAPTER_SOURCE_DIR, 'package.json')));
  const dependencies = jsonObject(adapter['dependencies']);
  const declared = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
  const allowed = Object.entries(ADAPTER_DEPENDENCIES).sort(([a], [b]) => a.localeCompare(b));
  if (
    declared.length !== allowed.length ||
    allowed.some(
      ([name, expected], at) => declared[at]?.[0] !== name || declared[at]?.[1] !== expected,
    )
  )
    throw new Error('adapter dependency set does not match the pinned packaging allowlist');
  const bundler = packageVersion(join(root, 'node_modules', BUNDLER.name), BUNDLER.name);
  if (bundler !== BUNDLER.version)
    throw new Error(`bundler version mismatch: expected ${BUNDLER.version}, observed ${bundler}`);
  return {
    identities: Object.freeze({
      '@executor-js/sdk': PINNED_VERSIONS.sdk,
      '@executor-js/plugin-openapi': PINNED_VERSIONS.pluginOpenapi,
      '@executor-js/plugin-mcp': PINNED_VERSIONS.pluginMcp,
      effect: PINNED_VERSIONS.effect,
      '@effect/platform-node-shared': PINNED_VERSIONS.platformNodeShared,
      [`@executor-js/sdk#${PINNED_SDK_CHUNK}`]: `sha256:${PINNED_SDK_CHUNK_SHA256}`,
      [`patch#${PINNED_PATCH_FILE}`]: `sha256:${PINNED_PATCH_SHA256}`,
      'lockfile#patch_hash': `sha256:${PINNED_PATCH_SHA256}`,
      [`bundler#${BUNDLER.name}`]: BUNDLER.version,
    }),
    patchHashRecords: patchHashes.length,
  };
}

/** Build the adapter bundle after asserting every pinned identity. */
export async function buildAdapterBundle(root: string): Promise<AdapterBundle> {
  const pins = assertPinnedBuildIdentities(root);
  const input = join(root, ADAPTER_SOURCE_DIR, ADAPTER_ENTRY);
  if (!existsSync(input)) throw new Error(`adapter build output is missing: ${input}`);
  const diagnostics: { level: string; code: string }[] = [];
  const build = await rolldown({
    input,
    platform: 'node',
    external: (id) => id.startsWith('@runnets/'),
    onLog: (level, log) => {
      diagnostics.push({ level, code: String(log.code ?? '') });
    },
  });
  let generated: Awaited<ReturnType<typeof build.generate>>;
  try {
    generated = await build.generate({
      dir: 'adapter-bundle',
      format: 'esm',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunk-[hash].js',
      sourcemap: false,
    });
  } finally {
    await build.close();
  }
  const fatal = diagnostics.filter(
    (entry) => entry.level === 'error' || /UNRESOLVED|PARSE|MISSING|ILLEGAL/.test(entry.code),
  );
  if (fatal.length > 0)
    throw new Error(
      'bundled adapter build reported diagnostics: ' + fatal.map((entry) => entry.code).join(', '),
    );
  const chunks = generated.output.filter((entry) => entry.type === 'chunk');
  if (chunks.length === 0) throw new Error('bundled adapter emitted no chunks');
  if (generated.output.length !== chunks.length)
    throw new Error('bundled adapter emitted unexpected build assets');
  const names = new Set(chunks.map((chunk) => chunk.fileName));
  if (!names.has('index.js')) throw new Error('bundled adapter emitted no index.js entry');
  const files = new Map<string, Buffer>();
  const filesSha256: Record<string, string> = {};
  let bytes = 0;
  for (const chunk of chunks) {
    if (!/^[A-Za-z0-9._-]+\.js$/.test(chunk.fileName))
      throw new Error(`bundled adapter emitted an unexpected file name: ${chunk.fileName}`);
    if (chunk.code.includes('sourceMappingURL'))
      throw new Error(`bundled adapter chunk ${chunk.fileName} references a source map`);
    const body = Buffer.from(chunk.code);
    files.set('dist/' + chunk.fileName, body);
    filesSha256['dist/' + chunk.fileName] = sha256(body);
    bytes += body.length;
  }
  const external = new Set<string>();
  const moduleIds = new Set<string>();
  for (const chunk of chunks) {
    for (const id of chunk.moduleIds) moduleIds.add(id);
    for (const specifier of [...chunk.imports, ...chunk.dynamicImports])
      if (!names.has(specifier)) external.add(specifier);
  }
  const unpackaged = [...external]
    .filter((specifier) => !isBuiltin(specifier) && !specifier.startsWith('@runnets/'))
    .sort();
  if (unpackaged.length > 0)
    throw new Error('bundled adapter left unpackaged external imports: ' + unpackaged.join(', '));
  for (const required of [
    '@executor-js/sdk/',
    '@executor-js/plugin-openapi/',
    '@executor-js/plugin-mcp/',
    'effect/',
  ])
    if (![...moduleIds].some((id) => id.includes(required)))
      throw new Error('bundled adapter did not include the pinned module ' + required.slice(0, -1));
  const chunkDigests = Object.fromEntries(
    [...files.keys()].sort().map((name) => [name.slice('dist/'.length), filesSha256[name] ?? '']),
  );
  const integrity = Buffer.from(
    JSON.stringify(
      {
        format: ADAPTER_INTEGRITY_FORMAT,
        pinnedVersions: PINNED_VERSIONS,
        pinnedSdkChunkSha256: PINNED_SDK_CHUNK_SHA256,
        pinnedPatchSha256: PINNED_PATCH_SHA256,
        bundler: BUNDLER,
        files: chunkDigests,
      },
      null,
      2,
    ) + '\n',
  );
  files.set('dist/' + ADAPTER_INTEGRITY_FILE, integrity);
  filesSha256['dist/' + ADAPTER_INTEGRITY_FILE] = sha256(integrity);
  return {
    files,
    filesSha256,
    integritySha256: sha256(integrity),
    identities: pins.identities,
    chunks: chunks.length,
    bytes,
  };
}
