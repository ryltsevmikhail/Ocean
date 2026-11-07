import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownFixture } from './model-process-lifecycle.ts';
export interface Reply {
  id: number;
  result?: unknown;
  error?: string;
}
export function child(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const p = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  ownFixture(() => kill(p));
  let stderr = '';
  p.stderr!.on('data', (b: Buffer) => {
    stderr += b.toString();
  });
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let sequence = 0;
  let readyResolve!: (value: unknown) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<unknown>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => {
    readyReject(Error('fixture_ready_timeout'));
    p.kill('SIGKILL');
  }, 10000);
  p.on('message', (message: Reply & { ready?: unknown }) => {
    if ('ready' in message) {
      clearTimeout(readyTimer);
      readyResolve(message.ready);
      return;
    }
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(Error(message.error));
    else entry.resolve(message.result);
  });
  p.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    const e = Error(`child_exit:${code ?? signal}:${stderr}`);
    readyReject(e);
    for (const entry of waiting.values()) entry.reject(e);
    waiting.clear();
  });
  return {
    p,
    ready,
    async call<T>(method: string, input: unknown = {}): Promise<T> {
      const id = ++sequence;
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(Error('fixture_timeout:' + method));
        }, 12000);
        waiting.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        p.send({ id, method, input });
      });
    },
    kill: () => kill(p),
  };
}
export async function kill(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    p.once('exit', () => resolve());
    p.kill('SIGKILL');
  });
}
export function serve(handler: (method: string, input: never) => unknown | Promise<unknown>) {
  process.on('message', (m: { id: number; method: string; input: never }) => {
    void Promise.resolve()
      .then(() => handler(m.method, m.input))
      .then(
        (result) => process.send!({ id: m.id, result }),
        (e: unknown) =>
          process.send!({ id: m.id, error: e instanceof Error ? e.message : 'fixture_failure' }),
      );
  });
}
