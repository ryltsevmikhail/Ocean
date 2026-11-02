import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  sandboxArgv,
  sandboxRoot,
  sandboxLimits,
  type SandboxRequest,
  type SandboxEvidence,
} from './sandbox-layout.js';
export { sandboxLimits } from './sandbox-layout.js';
export type { SandboxRequest, SandboxEvidence } from './sandbox-layout.js';
const execute = promisify(execFile);
const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/' + process.getuid?.() };
async function control(args: string[]): Promise<string> {
  return (
    await execute('/usr/bin/systemctl', ['--user', ...args], {
      env,
      timeout: 5000,
      maxBuffer: 65536,
    })
  ).stdout;
}
/** No project code executes until the host has observed the service cgroup. */
export async function runSandbox(request: SandboxRequest): Promise<SandboxEvidence> {
  request.signal?.throwIfAborted();
  await sandboxRoot(request.root, request.mounts, request.dependencyProjectRoot);
  const timeoutMs = Math.min(request.timeoutMs ?? sandboxLimits.timeoutMs, sandboxLimits.timeoutMs);
  if (timeoutMs < 1 || !Number.isFinite(timeoutMs)) throw new Error('invalid sandbox timeout');
  const outputBytes = Math.min(request.outputBytes ?? sandboxLimits.outputBytes, 1048576);
  const unit = 'ocean-worker-' + randomUUID() + '.service';
  const ready = 'OCEAN_READY_' + randomUUID();
  const script = `
    process.stdout.write(${JSON.stringify(ready)} + '\\n');
    process.stdin.once('data', () => {
      process.stdin.pause();
      const child = require('node:child_process').spawn(
        ${JSON.stringify(request.program)}, ${JSON.stringify(request.args)},
        {cwd:${JSON.stringify('/workspace' + (request.cwd ? '/' + request.cwd : ''))},
         env:process.env,stdio:['ignore','inherit','inherit'],shell:false});
      child.on('error',()=>process.exit(127));
      child.on('exit',(code)=>process.exit(code ?? 128));
    });
  `;
  const observed: { cgroup: string | null } = { cgroup: null };
  let reason: SandboxEvidence['reason'] = 'exit';
  let output = Buffer.alloc(0);
  let truncated = false;
  let readyBuffer = '';
  let admitted = false;
  let closed = false;
  let stopping: Promise<void> | undefined;
  const child = spawn(
    '/usr/bin/systemd-run',
    [
      '--user',
      '--quiet',
      '--wait',
      '--pipe',
      '--service-type=exec',
      '--unit=' + unit,
      '--property=KillMode=control-group',
      '--property=SendSIGKILL=yes',
      '--property=TimeoutStopSec=2s',
      '--property=RuntimeMaxSec=65s',
      '--property=MemoryMax=' + sandboxLimits.memoryBytes,
      '--property=TasksMax=' + sandboxLimits.processes,
      '--property=NoNewPrivileges=yes',
      '--property=ProtectControlGroups=yes',
      '/usr/bin/bwrap',
      ...sandboxArgv(request.root, script, request.mounts),
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false },
  );
  const stop = (): Promise<void> =>
    (stopping ??= control(['stop', unit]).then(
      () => {},
      () => {},
    ));
  const abort = (): void => {
    reason = 'cancelled';
    void stop();
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    reason = 'timeout';
    void stop();
  }, timeoutMs);
  const retain = (chunk: Buffer): void => {
    if (output.length + chunk.length > outputBytes) truncated = true;
    output = Buffer.concat([output, chunk.subarray(0, outputBytes - output.length)]);
  };
  child.stderr.on('data', retain);
  child.stdout.on('data', (chunk: Buffer) => {
    if (admitted) {
      retain(chunk);
      return;
    }
    readyBuffer += chunk.toString('utf8');
    if (
      readyBuffer.length > 1024 ||
      (!ready.startsWith(readyBuffer.trimEnd()) && !readyBuffer.startsWith(ready + '\n'))
    ) {
      reason = 'unavailable';
      void stop();
      return;
    }
    if (readyBuffer.startsWith(ready + '\n')) {
      admitted = true;
      void (async () => {
        try {
          const path = (await control(['show', unit, '--property=ControlGroup', '--value'])).trim();
          if (!/^\/user.slice\/[A-Za-z0-9_.@/-]+\/ocean-worker-[a-f0-9-]+\.service$/.test(path))
            throw new Error('invalid cgroup');
          await readFile('/sys/fs/cgroup' + path + '/cgroup.events', 'utf8');
          observed.cgroup = path;
          if (reason === 'exit' && !closed) child.stdin.end('go\n');
          else await stop();
        } catch {
          reason = 'unavailable';
          await stop();
        }
      })();
    }
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', () => {
      reason = 'unavailable';
      resolve(null);
    });
    child.on('close', (code) => {
      closed = true;
      resolve(code);
    });
  });
  clearTimeout(timer);
  request.signal?.removeEventListener('abort', abort);
  await stop();
  let cleanupConfirmed = false;
  if (observed.cgroup !== null) {
    try {
      const events = await readFile('/sys/fs/cgroup' + observed.cgroup + '/cgroup.events', 'utf8');
      cleanupConfirmed = /^populated 0$/m.test(events);
    } catch (error) {
      cleanupConfirmed = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    }
  }
  await control(['reset-failed', unit]).catch(() => {});
  return {
    output: output.toString('utf8'),
    truncated,
    exitCode,
    reason,
    cleanupConfirmed,
    cgroup: observed.cgroup,
  };
}
