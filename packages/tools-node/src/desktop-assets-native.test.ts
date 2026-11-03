import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { runSandbox } from './sandbox-supervision.js';
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses a real nested Desktop attachment mount before reading body bytes',
  async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-desktop-native-'));
    const task = join(root, 'task'),
      dependencies = join(root, 'deps'),
      id = '12345678-1234-4123-8123-123456789abc';
    const relative = 'desktop/node_modules';
    fs.mkdirSync(join(task, relative), { recursive: true, mode: 0o700 });
    fs.mkdirSync(join(dependencies, relative), { recursive: true, mode: 0o700 });
    fs.mkdirSync(join(dependencies, relative, id), { mode: 0o700 });
    fs.writeFileSync(join(task, '.git'), 'gitdir: /inert');
    fs.writeFileSync(join(dependencies, relative, id, 'blob'), 'synthetic protected mount bytes', {
      mode: 0o600,
    });
    try {
      for (const name of [
        'coding-asset-scan',
        'profile-backup-session',
        'profile-archive-context',
        'coding-asset-source',
        'coding-asset-selection',
        'coding-asset-state',
        'coding-asset-policy',
        'desktop-asset-policy',
      ])
        fs.copyFileSync(
          new URL('../dist/' + name + '.js', import.meta.url),
          join(task, name + '.js'),
        );
      const result = await runSandbox({
        root: task,
        dependencyProjectRoot: dependencies,
        mounts: [{ source: join(dependencies, relative), target: '/workspace/' + relative }],
        program: '/toolchain/node',
        args: [
          '--input-type=module',
          '-e',
          `
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {captureCodingAssetTree} from '/workspace/coding-asset-scan.js';
const original=fs.readSync;let reads=0;fs.readSync=(...args)=>{reads++;return original(...args);};syncBuiltinESMExports();
try {captureCodingAssetTree('/workspace/desktop',{},'desktop');throw Error('unexpected capture');}
catch(e){if(e.message!=='unsupported_coding_asset')throw e;}
if(reads!==0)throw Error('forbidden body read');console.log('desktop mount refused before body');`,
        ],
      });
      expect(result).toMatchObject({
        exitCode: 0,
        reason: 'exit',
        cleanupConfirmed: true,
        truncated: false,
        output: 'desktop mount refused before body\n',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
