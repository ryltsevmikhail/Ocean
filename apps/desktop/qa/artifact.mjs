// Private standalone Linux Desktop artifact from the exact committed revision.
// Packaging only: no installation, no launcher/menu/service changes, no GUI run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { packager } from '@electron/packager';
import { stageDesktopThirdPartyLicenses } from '../dist/types/artifact-licenses.js';

const ELECTRON_VERSION = '45.2.1';
const root = resolve(process.env.OCEAN_QA_PACKAGE_ROOT ?? '');
assert.ok(process.env.OCEAN_QA_PACKAGE_ROOT, 'OCEAN_QA_PACKAGE_ROOT is required');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
assert.equal(dirty, '', 'Desktop artifact requires a clean committed tree');
const desktop = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const version = process.env.OCEAN_QA_DESKTOP_VERSION ?? desktop.version;
for (const required of [
  'apps/desktop/dist/web/index.html',
  'apps/desktop/dist/preload.cjs',
  'apps/desktop/dist/types/host/main.js',
]) {
  assert.ok(existsSync(required), `missing built desktop output ${required}`);
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function walk(directory, prefix = '') {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    const name = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) entries.push(...walk(path, name));
    else if (entry.isFile())
      entries.push({ path: name, size: statSync(path).size, sha256: sha256(readFileSync(path)) });
    else throw new Error('unexpected artifact entry type: ' + name);
  }
  return entries;
}
/** The asar format is a small fixed header pickle followed by a JSON file tree. */
function asarInventory(path) {
  const bytes = readFileSync(path);
  const jsonSize = bytes.readUInt32LE(12);
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
  const names = [];
  const visit = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const current = prefix === '' ? name : prefix + '/' + name;
      if (value.files) visit(value, current);
      else names.push(current);
    }
  };
  visit(header, '');
  return { bytes, names, sha256: sha256(bytes), size: bytes.length };
}
const forbidden =
  /(^|\/)(\.env(\..*)?|deepseek\.env|runtime\.sqlite(-wal|-shm)?|last-backup\.json|restore-guard\.json|\.git|\.cache|node_modules\/\.pnpm)(\/|$)/;
const secretValue = /(?:DEEPSEEK_API_KEY\s*=\s*\S|sk-[A-Za-z0-9_-]{20,})/;
mkdirSync(root, { recursive: true, mode: 0o700 });
const stage = join(root, 'stage');
mkdirSync(stage, { recursive: true, mode: 0o700 });
cpSync('apps/desktop/dist', join(stage, 'dist'), { recursive: true });
for (const name of ['LICENSE', 'NOTICE']) cpSync(name, join(stage, name));
stageDesktopThirdPartyLicenses(resolve('apps/desktop'), stage);
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'ocean-desktop',
    productName: 'Ocean Desktop',
    version,
    type: desktop.type,
    main: desktop.main,
    license: desktop.license,
  }),
);
for (const name of ['tools-node', 'application', 'domain', 'contracts']) {
  const target = join(stage, 'node_modules', '@runnets', name);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  cpSync(join('packages', name, 'package.json'), join(target, 'package.json'));
  cpSync(join('packages', name, 'dist'), join(target, 'dist'), { recursive: true });
}
cpSync('apps/desktop/node_modules/zod', join(stage, 'node_modules', 'zod'), {
  recursive: true,
  dereference: true,
});
// Type declarations, source maps (build-machine paths) and build caches are not
// runtime artifacts and must not ship inside the ASAR.
for (const pattern of [
  '**/*.d.ts',
  '**/*.d.ts.map',
  '**/*.js.map',
  '**/*.tsbuildinfo',
  '**/.tsbuildinfo',
])
  for (const file of globSync(pattern, { cwd: stage })) rmSync(join(stage, file));
const [artifact] = await packager({
  dir: stage,
  out: join(root, 'artifact'),
  name: 'OceanDesktop',
  platform: 'linux',
  arch: 'x64',
  electronVersion: ELECTRON_VERSION,
  electronZipDir: process.env.OCEAN_QA_ELECTRON_ZIP_DIR,
  prune: false,
  asar: true,
});
const executable = join(artifact, 'OceanDesktop');
assert.ok(existsSync(executable), 'packaged executable is missing');
const asarPath = join(artifact, 'resources/app.asar');
assert.ok(existsSync(asarPath), 'packaged ASAR is missing');
const asar = asarInventory(asarPath);
assert.ok(asar.names.includes('LICENSE'), 'ASAR is missing LICENSE');
assert.ok(asar.names.includes('NOTICE'), 'ASAR is missing NOTICE');
for (const name of ['vue-MIT.txt', 'zod-MIT.txt'])
  assert.ok(asar.names.includes('THIRD_PARTY_LICENSES/' + name), 'ASAR is missing ' + name);
assert.ok(asar.names.includes('dist/types/host/main.js'), 'ASAR is missing the main entry');
for (const name of asar.names)
  assert.ok(!forbidden.test(name), 'ASAR ships forbidden entry ' + name);
assert.ok(
  !secretValue.test(asar.bytes.toString('latin1')),
  'ASAR bytes contain a secret-shaped value',
);
const inventory = walk(artifact);
const bytes = inventory.reduce((total, entry) => total + entry.size, 0);
for (const entry of inventory)
  assert.ok(!forbidden.test(entry.path), 'artifact ships ' + entry.path);
const summary = {
  format: 1,
  product: 'Ocean Desktop',
  version,
  revision,
  electron: ELECTRON_VERSION,
  platform: 'linux',
  arch: 'x64',
  bytes,
  files: inventory.length,
  asar: {
    path: 'resources/app.asar',
    sha256: asar.sha256,
    size: asar.size,
    entries: asar.names.length,
    licenses: [
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_LICENSES/vue-MIT.txt',
      'THIRD_PARTY_LICENSES/zod-MIT.txt',
    ],
  },
  executable: 'OceanDesktop',
  inventory,
};
writeFileSync(join(root, 'desktop-artifact.json'), JSON.stringify(summary, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      version,
      revision,
      artifact,
      bytes,
      files: inventory.length,
      asarSha256: asar.sha256,
      asarSize: asar.size,
      asarEntries: asar.names.length,
    },
    null,
    2,
  ),
);
