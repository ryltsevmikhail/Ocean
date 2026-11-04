/** Assemble compiled first-party runtime modules, the bundled Executor adapter and explicit docs. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createArchive } from './archive.js';
import {
  ADAPTER_DEPENDENCIES,
  ADAPTER_INTEGRITY_FILE,
  ADAPTER_PACKAGE,
  ADAPTER_SOURCE_DIR,
  buildAdapterBundle,
} from './bundle.js';
import {
  archiveFiles,
  sha256,
  type ReleaseBundleRecord,
  type ReleaseManifest,
} from './installer.js';

export interface ReleasePackage {
  readonly archive: string;
  readonly sha256: string;
  readonly bundle: ReleaseBundleRecord;
}

/** Package directory name of the one allowlisted bundled adapter. */
const ADAPTER_DIRECTORY = ADAPTER_SOURCE_DIR.split('/').at(-1) ?? '';

/** Refuse any package whose runtime dependencies would not be shipped. */
function checkDependencies(
  name: string,
  dependencies: Readonly<Record<string, string>>,
  modules: readonly string[],
): void {
  if (name === ADAPTER_DIRECTORY) {
    const declared = Object.keys(dependencies).sort(),
      allowed = Object.keys(ADAPTER_DEPENDENCIES).sort();
    if (declared.length !== allowed.length || declared.some((key, at) => key !== allowed[at]))
      throw new Error('Unexpected adapter dependency set');
    for (const [key, value] of Object.entries(dependencies))
      if (ADAPTER_DEPENDENCIES[key] !== value)
        throw new Error('Unpackaged runtime dependency ' + key);
    return;
  }
  for (const [key, value] of Object.entries(dependencies))
    if (!key.startsWith('@runnets/') || value !== 'workspace:*' || !modules.includes(key.slice(9)))
      throw new Error('Unpackaged runtime dependency ' + key);
}

/** The packaged tree must stay first-party-only: no maps, caches or nested node_modules. */
function assertPackagedLayout(files: ReadonlyMap<string, unknown>): void {
  for (const name of files.keys()) {
    if (name.endsWith('.map'))
      throw new Error('Release archive must not ship source maps: ' + name);
    if (/node_modules\/\.pnpm|node_modules\/\.cache|\.tsbuildinfo$/.test(name))
      throw new Error('Release archive must not ship build caches: ' + name);
    for (const [at, segment] of name.split('/').entries())
      if (segment === 'node_modules' && at !== 0)
        throw new Error('Release archive must not ship nested node_modules: ' + name);
    if (
      name.startsWith('node_modules/') &&
      !/^node_modules\/@runnets\/[a-z0-9][a-z0-9-]*\//.test(name)
    )
      throw new Error('Release archive must not ship an unpackaged dependency: ' + name);
  }
  for (const required of [
    'node_modules/@runnets/integrations-executor/package.json',
    'node_modules/@runnets/integrations-executor/LICENSE',
    'node_modules/@runnets/integrations-executor/dist/index.js',
    'node_modules/@runnets/integrations-executor/dist/' + ADAPTER_INTEGRITY_FILE,
    'node_modules/@runnets/integrations-executor/THIRD_PARTY_LICENSES',
  ])
    throwUnlessPresent(files, required);
}

function throwUnlessPresent(files: ReadonlyMap<string, unknown>, required: string): void {
  const present = required.endsWith('THIRD_PARTY_LICENSES')
    ? [...files.keys()].some((name) => name.startsWith(required + '/'))
    : files.has(required);
  if (!present) throw new Error('Release archive is missing ' + required);
}

export async function packageRelease(
  root: string,
  version: string,
  to: string,
): Promise<ReleasePackage> {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('invalid_version');
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.versions.node.split('.')[0] !== '26'
  )
    throw new Error('unsupported_runtime');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (dirty) throw new Error('Release packaging requires a clean committed tree');
  const files = new Map<string, { body: Buffer; mode: number }>();
  const add = (name: string, body: Buffer | string, mode = 0o644) =>
    files.set(name, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), mode });
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const compiled = (path: string) =>
    readFileSync(path, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  const copyDocs = (directory: string, relative: string) => {
    for (const e of readdirSync(directory, { withFileTypes: true })) {
      if (e.isDirectory()) copyDocs(join(directory, e.name), relative + e.name + '/');
      else if (e.isFile()) add(relative + e.name, readFileSync(join(directory, e.name)));
      else throw new Error('Unexpected document link');
    }
  };
  const modules = readdirSync(join(root, 'packages'));
  if (!modules.includes(ADAPTER_DIRECTORY))
    throw new Error('Release packaging requires the bundled adapter package ' + ADAPTER_PACKAGE);
  const adapter = await buildAdapterBundle(root);
  for (const name of [...modules, 'cli']) {
    const from = name === 'cli' ? join(root, 'apps', 'cli') : join(root, 'packages', name);
    const manifest = json(join(from, 'package.json'));
    const dependencies = (manifest['dependencies'] ?? {}) as Record<string, string>;
    checkDependencies(name, dependencies, modules);
    const destination = name === 'cli' ? 'apps/cli' : 'node_modules/@runnets/' + name;
    manifest['version'] = version;
    delete manifest['dependencies'];
    add(destination + '/package.json', JSON.stringify(manifest, null, 2) + '\n');
    if (name === ADAPTER_DIRECTORY) {
      // Ship the deterministic bundle instead of the tsc output; the pinned
      // dependency tree is inside the chunks, never as nested node_modules.
      for (const [path, body] of adapter.files) add(destination + '/' + path, body);
      add(destination + '/LICENSE', readFileSync(join(root, 'LICENSE')));
      const thirdParty = join(from, 'THIRD_PARTY_LICENSES');
      if (existsSync(thirdParty)) copyDocs(thirdParty, destination + '/THIRD_PARTY_LICENSES/');
      continue;
    }
    const copy = (directory: string, relative: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Unexpected build link');
        if (entry.isDirectory()) {
          if (entry.name !== 'release')
            copy(join(directory, entry.name), relative + entry.name + '/');
        } else if (entry.isFile() && entry.name.endsWith('.js'))
          add(
            destination + '/dist/' + relative + entry.name,
            compiled(join(directory, entry.name)),
          );
      }
    };
    copy(join(from, 'dist'), '');
    if (name === 'cli')
      add(
        destination + '/dist/release/installer.js',
        compiled(join(from, 'dist/release/installer.js')),
      );
  }
  for (const name of ['LICENSE', 'NOTICE', 'README.md']) add(name, readFileSync(join(root, name)));
  // The standalone Apache-2.0 checkout has no third-party LICENSES tree; include it when present.
  if (existsSync(join(root, 'LICENSES'))) copyDocs(join(root, 'LICENSES'), 'LICENSES/');
  copyDocs(join(root, 'docs'), 'docs/');
  add(
    'package.json',
    JSON.stringify({ name: 'ocean', version, type: 'module', license: 'Apache-2.0' }) + '\n',
  );
  add(
    'bin/ocean',
    `#!/bin/sh
set -eu
ocean_root="$(dirname "$(dirname "$(readlink -f "$0")")")"
exec node "$ocean_root/launch.js" "$@"
`,
    0o755,
  );
  add(
    'launch.js',
    `import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
if(process.platform!=='linux'||process.arch!=='x64'||process.version!==manifest.node) {
 console.error('Ocean requires Linux x64 and Node '+manifest.node);process.exit(2);
}
await import('./apps/cli/dist/main.js');
`,
  );
  const adapterRoot = 'node_modules/@runnets/' + ADAPTER_DIRECTORY + '/';
  for (const name of files.keys())
    if (name.startsWith(adapterRoot)) {
      const relative = name.slice(adapterRoot.length);
      if (
        !relative.startsWith('dist/') &&
        relative !== 'package.json' &&
        relative !== 'LICENSE' &&
        !relative.startsWith('THIRD_PARTY_LICENSES/')
      )
        throw new Error('Release archive ships an unexpected adapter file: ' + name);
    }
  assertPackagedLayout(files);
  const bundle: ReleaseBundleRecord = {
    adapter: ADAPTER_PACKAGE,
    entry: 'dist/index.js',
    integrity: 'dist/' + ADAPTER_INTEGRITY_FILE,
    integritySha256: adapter.integritySha256,
    files: adapter.filesSha256,
    identities: adapter.identities,
  };
  const inventory = Object.fromEntries(
    [...files].map(([name, e]) => [name, { sha256: sha256(e.body), mode: e.mode }]),
  );
  const manifest: ReleaseManifest = {
    format: 1,
    version,
    revision,
    node: process.version,
    platform: 'linux',
    arch: 'x64',
    lockfileSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
    files: inventory,
    bundle,
  };
  add('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  const bytes = createArchive(files);
  if (archiveFiles(bytes).size !== files.size) throw new Error('Archive roundtrip failed');
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const archive = join(to, 'ocean-' + version + '-linux-x64.tar.gz'),
    checksum = sha256(bytes);
  writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(archive + '.sha256', checksum + '  ' + archive.split('/').at(-1) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    join(to, 'ocean-install.mjs'),
    compiled(join(root, 'apps/cli/dist/release/installer.js')),
    { flag: 'wx', mode: 0o700 },
  );
  return { archive, sha256: checksum, bundle };
}
if (process.argv[1]?.endsWith('/release/package.js')) {
  const [, , version, to] = process.argv;
  if (!version || !to) throw new Error('Usage: pnpm package:release VERSION ABS_OUTPUT_DIR');
  process.stdout.write(
    JSON.stringify(await packageRelease(process.cwd(), version, resolve(to))) + '\n',
  );
}
