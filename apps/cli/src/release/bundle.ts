/** The one production adapter: public MCP client, with bounded first-party externals. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, dirname } from 'node:path';
import { rolldown } from 'rolldown';
import { sha256 } from './installer.js';
export const ADAPTER_PACKAGE = '@runnets/integrations-mcp';
export const ADAPTER_SOURCE_DIR = 'packages/integrations-mcp';
export const ADAPTER_ENTRY = 'dist/index.js';
export const ADAPTER_INTEGRITY_FILE = 'bundle-integrity.json';
export const ADAPTER_INTEGRITY_FORMAT = 1;
export const BUNDLER = { name: 'rolldown', version: '1.2.16' } as const;
export const ADAPTER_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@modelcontextprotocol/client': '2.4.0',
  '@runnets/application': 'workspace:*',
  '@runnets/domain': 'workspace:*',
  '@runnets/tools-node': 'workspace:*',
};
export const PINNED_LOCKFILE_SHA256 =
  '772997479409712d5501576dca97ea0fd475efbe5225a8311512ab9efda8515f';
export const PINNED_VERSIONS = { client: '2.4.0', core: '2.4.0' } as const;
export interface AdapterBundle {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly filesSha256: Readonly<Record<string, string>>;
  readonly integritySha256: string;
  readonly identities: Readonly<Record<string, string>>;
  readonly chunks: number;
  readonly bytes: number;
}
const FIRST_PARTY = new Set(['@runnets/application', '@runnets/domain', '@runnets/tools-node']);
function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
export function assertPinnedBuildIdentities(root: string) {
  if (sha256(readFileSync(join(root, 'pnpm-lock.yaml'))) !== PINNED_LOCKFILE_SHA256)
    throw Error('lockfile MCP identity mismatch');
  const modules = join(root, ADAPTER_SOURCE_DIR, 'node_modules');
  const client = realpathSync(join(modules, '@modelcontextprotocol/client'));
  const core = realpathSync(join(dirname(dirname(client)), '@modelcontextprotocol/core'));
  for (const [directory, version] of [
    [client, '2.4.0'],
    [core, '2.4.0'],
    [join(root, 'node_modules/rolldown'), BUNDLER.version],
  ])
    if (json(join(directory!, 'package.json'))['version'] !== version)
      throw Error('pinned version mismatch');
  const dependencies = json(join(root, ADAPTER_SOURCE_DIR, 'package.json'))['dependencies'];
  if (
    JSON.stringify(Object.entries(dependencies as object).sort()) !==
    JSON.stringify(Object.entries(ADAPTER_DEPENDENCIES).sort())
  )
    throw Error('adapter dependency set mismatch');
  const identities: Record<string, string> = {
    '@modelcontextprotocol/client': '2.4.0',
    '@modelcontextprotocol/core': '2.4.0',
    'bundler#rolldown': BUNDLER.version,
  };
  for (const [name, directory, paths] of [
    ['@modelcontextprotocol/client', client, ['dist/index.mjs', 'dist/stdio.mjs']],
    ['@modelcontextprotocol/core', core, ['dist/index.mjs']],
  ] as const)
    for (const path of paths)
      identities[name + '#' + path] = 'sha256:' + sha256(readFileSync(join(directory, path)));
  // Fixed public SDK inputs; source/lock drift must be reviewed before changing these pins.
  for (const [key, expected] of Object.entries(SDK_HASHES))
    if (identities[key] !== 'sha256:' + expected) throw Error('pinned SDK identity mismatch');
  return { identities: Object.freeze(identities) };
}
const SDK_HASHES: Readonly<Record<string, string>> = {
  '@modelcontextprotocol/client#dist/index.mjs':
    'b78923b9b9d342109f4fc2a03a9dcea7241fbb89bb2943ec4c9f05a23891b1cf',
  '@modelcontextprotocol/client#dist/stdio.mjs':
    'd44adf6ca40eb7a9cafb35dec9658de2b9e17c7dea6be01c06fb8e0d594dc211',
  '@modelcontextprotocol/core#dist/index.mjs':
    'b844a6f7626cd4f4456f3608e14176a2ccd50a66f0c19f73abb5c0b11b397165',
};

/** Build the adapter bundle after asserting every pinned identity. */
export async function buildAdapterBundle(root: string): Promise<AdapterBundle> {
  const pins = assertPinnedBuildIdentities(root);
  const input = join(root, ADAPTER_SOURCE_DIR, ADAPTER_ENTRY);
  if (!existsSync(input)) throw new Error(`adapter build output is missing: ${input}`);
  const diagnostics: { level: string; code: string }[] = [];
  const build = await rolldown({
    input,
    platform: 'node',
    external: (id) => FIRST_PARTY.has(id),
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
    .filter((specifier) => !isBuiltin(specifier) && !FIRST_PARTY.has(specifier))
    .sort();
  if (unpackaged.length > 0)
    throw new Error('bundled adapter left unpackaged external imports: ' + unpackaged.join(', '));
  for (const required of ['@modelcontextprotocol/client/', '@modelcontextprotocol/core/'])
    if (![...moduleIds].some((id) => id.includes(required)))
      throw new Error('bundled adapter did not include the pinned module ' + required);
  for (const id of moduleIds) assertProductionModule(id);
  const chunkDigests = Object.fromEntries(
    [...files.keys()].sort().map((name) => [name.slice('dist/'.length), filesSha256[name] ?? '']),
  );
  const integrity = Buffer.from(
    JSON.stringify(
      {
        format: ADAPTER_INTEGRITY_FORMAT,
        pinnedVersions: PINNED_VERSIONS,
        identities: pins.identities,
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

/** Check module identity; ancestor proof-directory names carry no production policy. */
export function assertProductionModule(id: string): void {
  if (
    /(?:^|\/)(?:packages\/integrations-executor|node_modules\/(?:@runnets\/integrations-executor|@executor-js\/[^/]+|@modelcontextprotocol\/server|rolldown))(?:\/|$)|\/(?:qualification|prototype)[^/]*\.[cm]?[jt]s$|\/test-fixtures\/|\/[^/]*fixture[^/]*\.[cm]?[jt]s$/.test(
      id,
    )
  )
    throw Error('dev-only module in production bundle');
}
