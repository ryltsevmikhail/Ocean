/** Assemble only compiled first-party runtime modules and explicit public documentation. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createArchive } from './archive.js';
import { archiveFiles, sha256, type ReleaseManifest } from './installer.js';

export function packageRelease(
  root: string,
  version: string,
  to: string,
): { archive: string; sha256: string } {
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
  const modules = readdirSync(join(root, 'packages'));
  for (const name of [...modules, 'cli']) {
    const from = name === 'cli' ? join(root, 'apps', 'cli') : join(root, 'packages', name);
    const manifest = json(join(from, 'package.json'));
    const dependencies = (manifest['dependencies'] ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(dependencies))
      if (
        !key.startsWith('@runnets/') ||
        value !== 'workspace:*' ||
        !modules.includes(key.slice(9))
      )
        throw new Error('Unpackaged runtime dependency ' + key);
    const destination = name === 'cli' ? 'apps/cli' : 'node_modules/@runnets/' + name;
    manifest['version'] = version;
    delete manifest['dependencies'];
    add(destination + '/package.json', JSON.stringify(manifest, null, 2) + '\n');
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
  const copyDocs = (directory: string, relative: string) => {
    for (const e of readdirSync(directory, { withFileTypes: true })) {
      if (e.isDirectory()) copyDocs(join(directory, e.name), relative + e.name + '/');
      else if (e.isFile()) add(relative + e.name, readFileSync(join(directory, e.name)));
      else throw new Error('Unexpected document link');
    }
  };
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
  return { archive, sha256: checksum };
}
if (process.argv[1]?.endsWith('/release/package.js')) {
  const [, , version, to] = process.argv;
  if (!version || !to) throw new Error('Usage: pnpm package:release VERSION ABS_OUTPUT_DIR');
  process.stdout.write(JSON.stringify(packageRelease(process.cwd(), version, resolve(to))) + '\n');
}
