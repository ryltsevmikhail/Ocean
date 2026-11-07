import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openManagedWorkspace } from './managed-workspace.js';
import { managedWorkspaceBootstrap } from './managed-workspace-bootstrap.js';
async function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'managed-raw-names-')),
    root = join(dir, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(join(dir, 'outside'), 'synthetic outside inode');
  for (const name of ['valid-é-猫', '\uFEFFbom', '\uFFFD'])
    fs.writeFileSync(join(root, name), 'benign');
  const held = await openManagedWorkspace(root, new AbortController().signal);
  return {
    dir,
    root,
    held,
    corrupt() {
      fs.linkSync(
        join(dir, 'outside'),
        Buffer.concat([Buffer.from(root + '/'), Buffer.from([0xff])]),
      );
    },
    async close() {
      await held.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function bootstrap(f: Awaited<ReturnType<typeof fixture>>) {
  const script = `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');${managedWorkspaceBootstrap(f.held.footprint)}checkWorkspace(3,${JSON.stringify(f.root)});console.log('checked');`;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe', f.held.fd],
    env: process.env,
  });
  let output = '',
    error = '';
  child.stdout!.on('data', (b: Buffer) => {
    output += b.toString();
  });
  child.stderr!.on('data', (b: Buffer) => {
    error += b.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, output, error };
}
it('rejects lossy raw directory names before host inventory can inspect their benign UTF-8 shadow', async () => {
  const f = await fixture();
  try {
    f.corrupt();
    await expect(openManagedWorkspace(f.root, new AbortController().signal)).rejects.toThrow(
      'filename',
    );
    expect(fs.statSync(join(f.dir, 'outside')).nlink).toBe(2);
  } finally {
    await f.close();
  }
});
it('rejects the same raw-byte shadow on the actual inherited bootstrap descriptor', async () => {
  const f = await fixture();
  try {
    f.corrupt();
    const result = await bootstrap(f);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain('filename');
  } finally {
    await f.close();
  }
});
it('accepts byte-valid UTF-8 names, including BOM and replacement characters, in both inventories', async () => {
  const f = await fixture();
  try {
    expect(f.held.inspect()).toBe(true);
    expect(await bootstrap(f)).toEqual({ code: 0, output: 'checked\n', error: '' });
  } finally {
    await f.close();
  }
});
