import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteProjectLeases } from './project-leases.js';
import { createNativeBackend } from './native.js';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-leases-'));
  roots.push(dir);
  return { dir, leases: new SqliteProjectLeases(join(dir, 'registry')) };
}
const holder = (id: string) => ({
  ownerId: id,
  taskId: id,
  requestId: id,
  binding: id,
  kind: 'coding' as const,
});
it('coordinates separate adapter instances, overlapping roots and stale token release', () => {
  const { dir, leases } = setup(),
    other = new SqliteProjectLeases(join(dir, 'registry'));
  const a = leases.acquire('/project', holder('a'));
  if (!a.ok) throw Error('lease');
  expect(other.acquire('/project/sub', holder('b')).ok).toBe(false);
  expect(other.acquire('/', holder('b')).ok).toBe(false);
  expect(other.acquire('/project-other', holder('b')).ok).toBe(true);
  expect(other.release({ ...a.value, ownerId: 'fake' })).toBe(false);
  expect(other.owns(a.value)).toBe(true);
  expect(other.release(a.value)).toBe(true);
  const b = other.acquire('/project', holder('c'));
  expect(b.ok).toBe(true);
  expect(leases.release(a.value)).toBe(true);
  if (b.ok) expect(leases.owns(b.value)).toBe(true);
});
it('updated native/compatibility tools cannot write or execute across a coding reservation', async () => {
  const { dir, leases } = setup();
  writeFileSync(join(dir, 'file'), 'before');
  const lease = leases.acquire(dir, holder('coding'));
  if (!lease.ok) throw Error('lease');
  const backend = await createNativeBackend(dir, { leases });
  await expect(backend.write('file', 'after', 'before')).rejects.toThrow('reserved');
  await expect(
    backend.command(
      process.execPath,
      ['-e', "require('node:fs').writeFileSync('must-not-run','x')"],
      '.',
      new AbortController().signal,
    ),
  ).rejects.toThrow('reserved');
  expect(readFileSync(join(dir, 'file'), 'utf8')).toBe('before');
  expect(existsSync(join(dir, 'must-not-run'))).toBe(false);
  leases.release(lease.value);
  await backend.write('file', 'after', 'before');
  expect(readFileSync(join(dir, 'file'), 'utf8')).toBe('after');
});
it('an uncontained legacy command retains a global hold when its outcome is uncertain', async () => {
  const { dir, leases } = setup(),
    backend = await createNativeBackend(dir, { leases });
  const result = await backend.command(
    process.execPath,
    ['-e', 'process.exit(0)'],
    '.',
    new AbortController().signal,
  );
  expect(result.uncertain).toBe(true);
  expect(leases.acquire('/different-project', holder('coding')).ok).toBe(false);
});
it('serializes simultaneous real processes and retains the winner after both exit', async () => {
  const { dir, leases } = setup(),
    root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const worker = String.raw`
 import {registerHooks} from 'node:module';import {existsSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
 const [root,directory,id]=process.argv.slice(1);
 registerHooks({resolve(s,c,next){
  if(s==='@runnets/domain')return next(pathToFileURL(join(root,'domain/src/index.ts')).href,c);
  if(s.endsWith('.js')&&c.parentURL?.startsWith(pathToFileURL(root).href)){
   const u=new URL(s,c.parentURL);u.pathname=u.pathname.slice(0,-3)+'.ts';
   if(existsSync(fileURLToPath(u)))return next(u.href,c);
  }return next(s,c);
 }});
 const {SqliteProjectLeases}=await import(pathToFileURL(join(root,'tools-node/src/project-leases.ts')).href);
 process.stdout.write('ready\n');
 await new Promise(r=>process.stdin.once('data',r));
 const value=new SqliteProjectLeases(directory).acquire('/project',{ownerId:id,taskId:id,requestId:id,binding:id,kind:'coding'});
 process.stdout.write(JSON.stringify(value)+'\n');process.stdin.destroy();
 `;
  const run = (id: string) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', worker, root, join(dir, 'registry'), id],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let text = '',
      error = '';
    child.stderr.on('data', (b: Buffer) => {
      error += b.toString();
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('close', (code) => {
        if (!text.startsWith('ready'))
          reject(Error('worker failed: ' + String(code) + ' ' + error));
      });
    });
    child.stdout.on('data', (b: Buffer) => {
      text += b.toString();
    });
    const done = new Promise<{ ok: boolean; value?: Parameters<typeof leases.owns>[0] }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0 ? resolve(JSON.parse(text.trim().split('\n').at(-1)!)) : reject(Error(error)),
        );
      },
    );
    return { child, ready, done };
  };
  const a = run('one'),
    b = run('two');
  try {
    await Promise.all([a.ready, b.ready]);
    a.child.stdin.end('go');
    b.child.stdin.end('go');
    const results = await Promise.all([a.done, b.done]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results.find((r) => r.ok)?.value;
    if (!winner) throw Error('winner');
    expect(new SqliteProjectLeases(join(dir, 'registry')).owns(winner)).toBe(true);
    expect(leases.acquire('/project', holder('restart')).ok).toBe(false);
  } finally {
    a.child.kill('SIGKILL');
    b.child.kill('SIGKILL');
  }
}, 15000);
