import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareManagedStdio } from '@runnets/tools-node';
const [proof, mode, artifact, digest, profile] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];
assert.match(proof, /^\/home\/ryltsevmg\/Projects\/Ocean-artifacts\/task-19\.3\/native-[^/]+$/);
const target = join(proof, 'target'),
  root = join(proof, 'alias');
mkdirSync(target);
mkdirSync(root);
writeFileSync(join(target, 'fixture.json'), '{}');
if (mode === 'alias') execFileSync('/usr/bin/mount', ['--bind', target, root]);
else {
  const imported = join(root, 'imported');
  if (mode === 'file') {
    writeFileSync(imported, '');
    writeFileSync(join(target, 'file'), 'external');
  } else mkdirSync(imported);
  execFileSync('/usr/bin/mount', [
    '--bind',
    mode === 'file' ? join(target, 'file') : target,
    imported,
  ]);
}
let failure = '';
try {
  const handle = await prepareManagedStdio({
    profileRoot: profile,
    workspace: root,
    connectionId: 'kernel-negative',
    artifact,
    sha256: digest,
    args: [],
    signal: AbortSignal.timeout(5000),
  });
  await handle.cleanup();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
assert.match(failure, /unqualified managed alias|nested managed mount/);
assert.equal(existsSync(join(root, 'startup')), false);
const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
  .split('\n')
  .filter((line) => line.includes(proof));
writeFileSync(
  join(proof, 'kernel-' + mode + '.json'),
  JSON.stringify(
    {
      failure,
      mounts,
      startup: 0,
      namespace: readFileSync('/proc/self/mountinfo', 'utf8').includes(' shared:')
        ? 'shared'
        : 'private',
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ mode, failure, startup: 0, mountWitness: mounts }));
