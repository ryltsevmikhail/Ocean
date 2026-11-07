import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { openManagedWorkspace } from '@runnets/tools-node';
import { sandboxLauncher } from '../../../packages/tools-node/dist/sandbox-launcher.js';
import { sandboxArgv } from '../../../packages/tools-node/dist/sandbox-layout.js';
const [proof, mode] = process.argv.slice(2) as [string, string];
assert.match(proof, /^\/home\/ryltsevmg\/Projects\/Ocean-artifacts\/task-19\.3\/native-[^/]+$/);
assert.ok(['directory', 'file', 'raw-name', 'utf8'].includes(mode));
const root = join(proof, 'late-root'),
  target = join(proof, 'late-external'),
  imported = join(root, 'imported');
fs.mkdirSync(root);
fs.mkdirSync(target);
fs.writeFileSync(join(target, 'outside'), 'synthetic external bytes');
for (const name of ['valid-é-猫', '\uFEFFbom', '\uFFFD'])
  fs.writeFileSync(join(root, name), 'benign');
if (mode === 'file') fs.writeFileSync(imported, '');
if (mode === 'directory') fs.mkdirSync(imported);
const witness = await openManagedWorkspace(root, AbortSignal.timeout(8000));
let mounted = false;
try {
  const argv = sandboxArgv(
    root,
    "require('node:fs').writeFileSync('/workspace/startup','started')",
    [],
    await realpath(process.execPath),
  );
  argv.splice(argv.indexOf('/workspace/.git') - 2, 3);
  const launcher = await sandboxLauncher(argv, {}, undefined, witness.footprint);
  const before = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  if (mode === 'directory' || mode === 'file') {
    execFileSync('/usr/bin/mount', [
      '--bind',
      mode === 'file' ? join(target, 'outside') : target,
      imported,
    ]);
    mounted = true;
  } else if (mode === 'raw-name') {
    fs.linkSync(
      join(target, 'outside'),
      Buffer.concat([Buffer.from(root + '/'), Buffer.from([0xff])]),
    );
  }
  const changed = fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .filter((line) => line.includes(proof));
  let code = 0,
    stdout = '',
    stderr = '';
  try {
    ({ stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', launcher], {
      env: process.env,
      timeout: 8000,
    }));
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    code = e.code;
    stdout = e.stdout;
    stderr = e.stderr;
  }
  const startup = Number(fs.existsSync(join(root, 'startup')));
  if (mode === 'utf8') {
    assert.equal(code, 0, stderr);
    assert.equal(startup, 1);
  } else {
    assert.notEqual(code, 0);
    assert.equal(startup, 0);
    assert.match(
      stderr,
      mode === 'raw-name' ? /unsupported managed filename/ : /managed nested mount/,
    );
  }
  assert.equal(fs.readFileSync(join(target, 'outside'), 'utf8'), 'synthetic external bytes');
  fs.writeFileSync(
    join(proof, 'late-' + mode + '.json'),
    JSON.stringify(
      {
        mode,
        prepared: witness.footprint,
        preparedMounts: before.split('\n').filter((line) => line.includes(proof)),
        changedMounts: changed,
        code,
        stdout,
        stderr,
        startup,
        outsideLinks: fs.statSync(join(target, 'outside')).nlink,
        namespace: fs.readlinkSync('/proc/self/ns/mnt'),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ mode, code, startup, changedMounts: changed }));
} finally {
  if (mounted) execFileSync('/usr/bin/umount', [imported]);
  await witness.close();
  fs.writeFileSync(
    join(proof, 'late-namespace-cleanup.json'),
    JSON.stringify({
      namespace: fs.readlinkSync('/proc/self/ns/mnt'),
      importedUnmounted: !fs
        .readFileSync('/proc/self/mountinfo', 'utf8')
        .split('\n')
        .some((line) => line.split(' ')[4] === imported),
      closed: true,
    }),
  );
}
