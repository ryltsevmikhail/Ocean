import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
export function child(args: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(process.execPath, [resolve('apps/cli/dist/main.js'), ...args], {
    env,
    stdio: 'pipe',
  });
  let out = '',
    err = '';
  proc.stdout.on('data', (b: Buffer) => {
    out += b.toString();
  });
  proc.stderr.on('data', (b: Buffer) => {
    err += b.toString();
  });
  const exit = new Promise<number | null>((done, reject) => {
    proc.once('error', reject);
    proc.once('close', done);
  });
  return { proc, exit, out: () => out, err: () => err };
}
export function profileCli(profile: string, run: string) {
  return async (...args: string[]) => {
    const p = child([...args, '--profile', profile, '--json'], {
      PATH: process.env['PATH'],
      XDG_RUNTIME_DIR: run,
    });
    p.proc.stdin.end();
    const code = await p.exit;
    return { code, reply: p.out() ? JSON.parse(p.out()) : { stderr: p.err() } };
  };
}
