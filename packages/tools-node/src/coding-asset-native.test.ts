import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSandbox } from './sandbox-supervision.js';
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses a real bind-mounted child in a qualified private namespace',
  async () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-asset-native-'));
    const root = join(outer, 'task'),
      dependencies = join(outer, 'dependencies');
    mkdirSync(join(root, 'project/node_modules'), { recursive: true });
    mkdirSync(join(dependencies, 'project/node_modules'), { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: /host/not-visible');
    writeFileSync(join(dependencies, 'project/node_modules/dependency.js'), 'synthetic dependency');
    const source = readFileSync(
      process.env['OCEAN_RC_INSTALL']
        ? join(
            process.env['OCEAN_RC_INSTALL'],
            'node_modules/@runnets/tools-node/dist/coding-asset-scan.js',
          )
        : new URL('../dist/coding-asset-scan.js', import.meta.url),
      'utf8',
    );
    try {
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
          source +
            String.raw`
const testRoot=fs.openSync('/workspace/project',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
const testChild=fs.openSync('/workspace/project/node_modules',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
const testMountOf=fd=>/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'))?.[1];
if(testMountOf(testRoot)===testMountOf(testChild)) throw Error('fixture child is not a separate mount');
if(fs.fstatSync(testRoot).uid!==process.getuid()||fs.fstatSync(testChild).uid!==process.getuid()) throw Error('fixture ownership mismatch');
fs.closeSync(testRoot);fs.closeSync(testChild);
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
