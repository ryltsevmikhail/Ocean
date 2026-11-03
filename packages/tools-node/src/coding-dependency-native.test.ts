import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSandbox } from './sandbox-supervision.js';
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'proves real nested-mount denial and source-independent dependency quarantine in a Linux sandbox',
  async () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-dependency-native-')),
      root = join(outer, 'task'),
      deps = join(outer, 'mounts');
    fs.mkdirSync(join(root, 'deps/child/node_modules'), { recursive: true });
    fs.mkdirSync(join(deps, 'deps/child/node_modules'), { recursive: true });
    fs.writeFileSync(join(deps, 'deps/child/node_modules/secret'), 'synthetic mount canary');
    fs.writeFileSync(join(root, '.git'), 'gitdir: /inert');
    try {
      fs.mkdirSync(join(deps, 'node_modules/@runnets/domain'), { recursive: true });
      fs.mkdirSync(join(root, 'node_modules'));
      fs.cpSync(
        new URL('../../domain/dist', import.meta.url),
        join(deps, 'node_modules/@runnets/domain/dist'),
        { recursive: true },
      );
      fs.writeFileSync(
        join(deps, 'node_modules/@runnets/domain/package.json'),
        JSON.stringify({ type: 'module', exports: './dist/index.js' }),
      );
      for (const name of [
        'coding-dependency-tree',
        'coding-dependency-record',
        'coding-dependency-path',
        'coding-dependency-witness',
        'coding-dependency-budget',
        'coding-dependency-archive',
        'coding-dependency-config',
        'coding-dependency-graph',
        'coding-dependency-mapping',
        'coding-dependency-verification',
        'coding-asset-archive',
        'coding-asset-restore',
        'coding-asset-io',
        'coding-asset-scan',
        'profile-backup-session',
        'profile-backup-accounting',
        'profile-archive-context',
        'coding-asset-policy',
        'desktop-asset-policy',
        'coding-asset-selection',
        'coding-asset-source',
        'coding-asset-state',
        'coding-asset-links',
        'coding-asset-validation',
      ])
        fs.copyFileSync(
          new URL('../dist/' + name + '.js', import.meta.url),
          join(root, name + '.js'),
        );
      const result = await runSandbox({
        root,
        dependencyProjectRoot: deps,
        mounts: [
          { source: join(deps, 'node_modules'), target: '/workspace/node_modules' },
          {
            source: join(deps, 'deps/child/node_modules'),
            target: '/workspace/deps/child/node_modules',
          },
        ],
        program: '/toolchain/node',
        args: [
          '--input-type=module',
          '-e',
          String.raw`
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {captureCodingDependencyAssets} from '/workspace/coding-dependency-graph.js';
import {archiveCodingDependencyAssets,verifyCodingDependencyArchive,restoreCodingDependencyTask} from '/workspace/coding-dependency-archive.js';
import {captureCodingAssetTree} from '/workspace/coding-asset-scan.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
fs.mkdirSync('/tmp/profile',{mode:0o700});fs.mkdirSync('/tmp/task',{mode:0o700});
fs.mkdirSync('/tmp/task/local');fs.writeFileSync('/tmp/task/local/index.cjs','module.exports=42');
const policy={version:1,devCapabilities:['project_read'],reviewCapabilities:['changeset_read'],testPresets:[]};
const body={format:1,tasks:[{id:'task',workspaceId:'workspace',projectRoot:'/absent/project',baseCommit:'a'.repeat(40),worktreeRoot:'/tmp/task',ownerId:'owner',status:'reserved',policyVersion:1,policy}],worktrees:[],changesets:[],applications:[]};
const inventory={...body,hash:hash(body)},trees=[{taskId:'task',capture:captureCodingAssetTree('/tmp/task',{},'coding-worktree')}];
const register=(dependencyProjectRoot,mounts)=>fs.writeFileSync('/tmp/profile/coding-projects.json',JSON.stringify([{id:'registered',root:'/absent/project',testPresets:[],dependencyProjectRoot,mounts}]),{mode:0o600});
fs.renameSync('/workspace/deps/child','/workspace/deps/node_modules');
register('/workspace/deps',[{source:'/workspace/deps/node_modules',target:'/workspace/node_modules'}]);
const parent=fs.openSync('/workspace/deps/node_modules',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),child=fs.openSync('/workspace/deps/node_modules/node_modules',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
const mount=fd=>/^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8'))[1];if(mount(parent)===mount(child))throw Error('not a separate mount');fs.closeSync(parent);fs.closeSync(child);
let refused=false;try{await captureCodingDependencyAssets(inventory,'/tmp/profile',trees,async()=>{});}catch(e){if(e.message!=='unsupported_coding_asset')throw e;refused=true;}if(!refused)throw Error('mount accepted');
fs.mkdirSync('/tmp/deps');fs.mkdirSync('/tmp/deps/node_modules');fs.symlinkSync('../local','/tmp/deps/node_modules/local');
fs.mkdirSync('/tmp/bin');fs.writeFileSync('/tmp/bin/pnpm','synthetic executable',{mode:0o755});
register('/tmp/deps',[{source:'/tmp/deps/node_modules',target:'/workspace/node_modules'},{source:'/tmp/bin/pnpm',target:'/toolchain/pnpm/bin/pnpm'}]);
await archiveCodingDependencyAssets(inventory,'/tmp/profile',trees,'/tmp/archive');
for(const p of ['/tmp/profile','/tmp/deps','/tmp/task','/tmp/bin'])fs.rmSync(p,{recursive:true});
verifyCodingDependencyArchive('/tmp/archive');restoreCodingDependencyTask('/tmp/archive','task','/tmp/quarantine');
const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);if(require('/tmp/quarantine/materialized/tree/workspace/node_modules/local/index.cjs')!==42)throw Error('broken package');
if(fs.statSync('/tmp/quarantine/materialized/tree/toolchain/pnpm/bin/pnpm').mode%512!==493)throw Error('lost toolchain mode');
process.stdout.write('mount refused; dependency closure restored');
`,
        ],
      });
      expect(result).toMatchObject({
        exitCode: 0,
        reason: 'exit',
        cleanupConfirmed: true,
        truncated: false,
        output: 'mount refused; dependency closure restored',
      });
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
  30000,
);
