import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSandbox } from './sandbox-supervision.js';
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses a real bind-mounted child in tree and Git evidence readers in a private namespace',
  async () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-asset-native-'));
    const root = join(outer, 'task'),
      dependencies = join(outer, 'dependencies');
    mkdirSync(join(root, 'project/node_modules'), { recursive: true });
    mkdirSync(join(dependencies, 'project/node_modules'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /host/not-visible');
    writeFileSync(join(dependencies, 'project/node_modules/dependency.js'), 'synthetic dependency');
    try {
      for (const module of [
        'coding-git-observer.js',
        'coding-git-storage.js',
        'coding-asset-io.js',
        'coding-asset-scan.js',
        'coding-asset-policy.js',
        'desktop-asset-policy.js',
        'coding-asset-selection.js',
        'coding-asset-source.js',
        'coding-asset-state.js',
      ]) {
        const built = process.env['OCEAN_RC_INSTALL']
          ? join(process.env['OCEAN_RC_INSTALL'], 'node_modules/@runnets/tools-node/dist', module)
          : new URL('../dist/' + module, import.meta.url);
        writeFileSync(join(root, module), readFileSync(built));
      }
      const evidence = await runSandbox({
        root,
        dependencyProjectRoot: dependencies,
        mounts: [
          {
            source: join(dependencies, 'project/node_modules'),
            target: '/workspace/project/node_modules',
          },
        ],
        program: '/toolchain/node',
        args: [
          '--input-type=module',
          '-e',
          String.raw`
import * as fs from 'node:fs';
import {captureCodingAssetTree} from '/workspace/coding-asset-scan.js';
import {GitEvidenceObserver} from '/workspace/coding-git-observer.js';
const testRoot=fs.openSync('/workspace/project',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
const testChild=fs.openSync('/workspace/project/node_modules',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
const testMountOf=fd=>/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'))?.[1];
if(testMountOf(testRoot)===testMountOf(testChild)) throw Error('fixture child is not a separate mount');
if(fs.fstatSync(testRoot).uid!==process.getuid()||fs.fstatSync(testChild).uid!==process.getuid()) throw Error('fixture ownership mismatch');
fs.closeSync(testRoot);fs.closeSync(testChild);
const gitObserver=new GitEvidenceObserver();
try {
 const parent=gitObserver.directory('/workspace/project');
 try {gitObserver.child(parent,'node_modules');throw Error('Git metadata cross-mount unexpectedly succeeded');}
 catch(error){if(error.message!=='unsupported_coding_git_storage')throw error;}
} finally {gitObserver.close();}
fs.writeFileSync('/workspace/project/b.key','synthetic credential canary');
fs.linkSync('/workspace/project/b.key','/workspace/project/a');
const {syncBuiltinESMExports}=await import('node:module');
const originalRead=fs.default.readSync;let bodyReads=0;
fs.default.readSync=(...args)=>{bodyReads++;return originalRead(...args);};syncBuiltinESMExports();
try {
  try {captureCodingAssetTree('/workspace/project',{},'coding-worktree');throw Error('protected capture unexpectedly succeeded');}
  catch(error){if(error.message!=='protected_coding_asset')throw error;}
  fs.mkdirSync('/tmp/recovery',{mode:0o700});
  fs.writeFileSync('/tmp/recovery/private.key','synthetic recovery canary');
  try {captureCodingAssetTree('/tmp/recovery',{},'coding-recovery');throw Error('recovery credential capture unexpectedly succeeded');}
  catch(error){if(error.message!=='protected_coding_asset')throw error;}
  if(bodyReads!==0)throw Error('protected body was read');
} finally {fs.default.readSync=originalRead;syncBuiltinESMExports();}
try {captureCodingAssetTree('/workspace/project');throw Error('cross-mount capture unexpectedly succeeded');}
catch(error) {if(error.message!=='unsupported_coding_asset')throw error;}
process.stdout.write('cross-mount refused');
`,
        ],
      });
      expect(evidence).toMatchObject({
        exitCode: 0,
        reason: 'exit',
        cleanupConfirmed: true,
        truncated: false,
        output: 'cross-mount refused',
      });
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  },
  20000,
);
