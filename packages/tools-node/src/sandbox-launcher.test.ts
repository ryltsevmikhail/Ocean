import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sandboxLauncher } from './sandbox-launcher.js';

it.each(['replacement', 'rewrite'])(
  'rejects mount source %s after preparing the bootstrap',
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-launcher-'));
    try {
      const source = join(root, 'fixture');
      await writeFile(source, 'qualified');
      const launcher = await sandboxLauncher(['--ro-bind', source, '/fixture']);
      if (change === 'replacement') await rename(source, source + '.old');
      await writeFile(source, 'replacement');
      await expect(promisify(execFile)(process.execPath, ['-e', launcher])).rejects.toMatchObject({
        stderr: expect.stringContaining('mount source changed before opening'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'keeps a copied executable mount stable after host modification',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-binddata-'));
    try {
      const source = join(root, 'fixture');
      await writeFile(source, 'qualified');
      const script = await sandboxLauncher([
        '--unshare-all',
        '--ro-bind',
        '/usr',
        '/usr',
        '--symlink',
        'usr/lib',
        '/lib',
        '--symlink',
        'usr/lib',
        '/lib64',
        '--ro-bind',
        source,
        '/fixture',
        '/usr/bin/sh',
        '-c',
        'echo ready; sleep 0.2; cat /fixture',
      ]);
      const exchangeBeforeMount = `
        {
          const cp=require('node:child_process'), spawn=cp.spawn;
          cp.spawn=(...args)=>{
            require('node:fs').writeFileSync(${JSON.stringify(source)},'changed-before-mount');
            return spawn(...args);
          };
        }
      `;
      const child = spawn(process.execPath, ['-e', exchangeBeforeMount + script]);
      let output = '',
        errors = '';
      const changed = new Promise<void>((resolve) => {
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('ready')) void writeFile(source, 'replacement').then(resolve);
        });
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code, errors).toBe(0);
      await changed;
      expect(output).toBe('ready\nqualified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
