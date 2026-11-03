// Independent private Linux package qualification; never installs into a user prefix.
import assert from 'node:assert/strict';
import { cpSync, globSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { packager } from '@electron/packager';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';

assert.ok(process.env.OCEAN_QA_CLI && process.env.OCEAN_QA_PACKAGE_ROOT);
const root = resolve(process.env.OCEAN_QA_PACKAGE_ROOT);
mkdirSync(root, { mode: 0o700 });
const stage = join(root, 'stage');
mkdirSync(stage, { mode: 0o700 });
cpSync('apps/desktop/dist', join(stage, 'dist'), { recursive: true });
for (const name of ['LICENSE', 'NOTICE']) cpSync(name, join(stage, name));
const pkg = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'ocean-desktop',
    productName: 'Ocean Desktop',
    version: pkg.version,
    type: pkg.type,
    main: pkg.main,
    license: pkg.license,
  }),
);
for (const name of ['tools-node', 'application', 'domain', 'contracts']) {
  const target = join(stage, 'node_modules', '@runnets', name);
  mkdirSync(target, { recursive: true });
  cpSync(join('packages', name, 'package.json'), join(target, 'package.json'));
  cpSync(join('packages', name, 'dist'), join(target, 'dist'), { recursive: true });
}
cpSync('apps/desktop/node_modules/zod', join(stage, 'node_modules', 'zod'), {
  recursive: true,
  dereference: true,
});
for (const file of globSync(['**/*.tsbuildinfo', '**/.tsbuildinfo'], { cwd: stage }))
  rmSync(join(stage, file));
const [artifact] = await packager({
  dir: stage,
  out: join(root, 'artifact'),
  name: 'OceanDesktop',
  platform: 'linux',
  arch: 'x64',
  electronVersion: '45.2.1',
  electronZipDir: process.env.OCEAN_QA_ELECTRON_ZIP_DIR,
  prune: false,
  asar: true,
});
const executable = join(artifact, 'OceanDesktop');
const f = await fixture({ root: process.env.OCEAN_QA_ROOT, preserve: true });
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
let gui;
try {
  const bot = f.command('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Fixture');
  const room = f.command('room', 'direct', '--bot', bot.data.id).data.id;
  gui = await currentWindow(f, 'standalone', executable);
  await gui.page.getByRole('button', { name: '@dev', exact: true }).click();
  await gui.page.getByLabel('Сообщение', { exact: true }).fill('detach-turn');
  await gui.page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await gui.page.getByRole('button', { name: 'Остановить ответ @dev', exact: true }).waitFor();
  const before = await gui.page.evaluate(
    (room) => globalThis.ocean.request({ op: 'runs', room }),
    room,
  );
  await gui.close();
  gui = undefined;
  assert.equal(f.command('runtime', 'status').state, 'ready');
  writeFileSync(join(f.root, 'requests.release'), 'release');
  gui = await currentWindow(f, 'standalone-reopened', executable);
  await gui.page.getByRole('button', { name: '@dev', exact: true }).click();
  await gui.page
    .locator('#history')
    .getByText('Test provider · detach-turn', { exact: true })
    .waitFor();
  await gui.page.screenshot({ path: join(f.root, 'standalone.png') });
  assert.equal(f.command('history', room).length, 2);
  assert.equal(readFileSync(join(f.root, 'requests'), 'utf8').trimEnd().split('\n').length, 1);
  const after = await gui.page.evaluate(
    (room) => globalThis.ocean.request({ op: 'runs', room }),
    room,
  );
  assert.equal(after.data[0].runId, before.data[0].runId);
  assert.equal(after.data[0].turnStatus, 'completed');
  await gui.close();
  gui = undefined;
  writeFileSync(
    join(root, 'proof.json'),
    JSON.stringify(
      {
        artifact,
        executable,
        fixture: f.root,
        room,
        before,
        after,
        providerDispatches: 1,
        executableSHA256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
        asarSHA256: createHash('sha256')
          .update(readFileSync(join(artifact, 'resources', 'app.asar')))
          .digest('hex'),
      },
      null,
      2,
    ),
  );
  console.log('STANDALONE VERIFIED', artifact, f.root);
} finally {
  await gui?.dispose();
  await f.close();
}
