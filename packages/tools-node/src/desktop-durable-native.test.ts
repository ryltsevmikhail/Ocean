import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { desktopBindingIdentity, desktopBindingMatches } from './desktop-root.js';
import { desktopRootIdentity } from './desktop-assets.js';
it.runIf(
  process.platform === 'linux' &&
    process.arch === 'x64' &&
    process.env['OCEAN_DESKTOP_BTRFS_NATIVE'] === '1',
)(
  'uses the fixed descriptor helper on native Btrfs, stable after children writes and distinct for a copied replacement',
  () => {
    const root = fs.mkdtempSync(join(process.cwd(), '.desktop-btrfs-native-'));
    try {
      const tree = join(root, 'tree');
      fs.mkdirSync(tree, { mode: 0o700 });
      expect(Number(fs.statfsSync(tree).type)).toBe(0x9123683e);
      const identity = desktopBindingIdentity(tree);
      expect(identity).toMatch(/^linux-btrfs-v1:/);
      expect(identity).not.toBe(desktopRootIdentity(tree));
      const binding = { profileId: 'a'.repeat(64), root: tree, identity, originalRoot: '/inert' };
      fs.writeFileSync(join(tree, 'child'), 'synthetic bytes', { mode: 0o600 });
      fs.mkdirSync(join(tree, 'room'), { mode: 0o700 });
      expect(desktopBindingIdentity(tree)).toBe(identity);
      expect(desktopBindingMatches(binding)).toBe(true);
      fs.renameSync(tree, tree + '-held');
      expect(desktopBindingIdentity(tree + '-held')).toBe(identity);
      fs.cpSync(tree + '-held', tree, { recursive: true });
      fs.chmodSync(tree, 0o700);
      expect(() => desktopBindingMatches(binding)).toThrow('desktop_binding_mismatch');
      expect(desktopBindingIdentity(tree)).not.toBe(identity);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);
it.runIf(
  process.platform === 'linux' &&
    process.arch === 'x64' &&
    process.env['OCEAN_DESKTOP_BTRFS_NATIVE'] === '1',
)(
  'accepts a real new mount namespace and refuses a mount substitution during a held operation',
  async () => {
    const { spawnSync } = await import('node:child_process');
    const root = fs.mkdtempSync(join(process.cwd(), '.desktop-btrfs-remap-'));
    try {
      const identity = desktopBindingIdentity(root),
        transient = desktopRootIdentity(root);
      for (const mapping of ['--map-current-user', '--map-root-user']) {
        const result = spawnSync(
          '/usr/bin/unshare',
          [
            '--user',
            mapping,
            '--mount',
            process.execPath,
            '--input-type=module',
            '-e',
            `
import {execFileSync} from 'node:child_process';
let [root,identity,transient,module,mapping]=process.argv.slice(1);
const {desktopBindingIdentity,desktopBindingMatches,holdDesktopRoot}=await import(module);
const {desktopRootIdentity}=await import(new URL('./desktop-assets.js',module));
if(mapping==='--map-root-user')identity=desktopBindingIdentity(root);
const binding={profileId:'a'.repeat(64),root,identity,originalRoot:'/inert'};
if(desktopRootIdentity(root)===transient)throw Error('mount did not change');
if(!desktopBindingMatches(binding))throw Error('durable identity rejected');
if(mapping==='--map-root-user'){
const held=holdDesktopRoot(root,identity);
try {
 execFileSync('/usr/bin/mount',['--bind',root,root],{env:{},timeout:2000});
 let refused=false;try{held.verify();}catch{refused=true;}
 if(!refused)throw Error('mid-operation mount accepted');
} finally {held.close();}
}
if(!desktopBindingMatches(binding)||desktopBindingIdentity(root)!==identity)throw Error('new operation refused');
console.log('namespace drift accepted; mid-operation mount refused');
`,
            root,
            identity,
            transient,
            new URL('../dist/desktop-root.js', import.meta.url).href,
            mapping,
          ],
          {
            env: {},
            cwd: '/',
            encoding: 'utf8',
            timeout: 8000,
            maxBuffer: 8192,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe('namespace drift accepted; mid-operation mount refused');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);
