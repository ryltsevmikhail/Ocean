import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
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
function populated(events: string, expected: 0 | 1): boolean {
  const fields = events.split('\n').filter((line) => /^populated\b/.test(line));
  return fields.length === 1 && fields[0] === 'populated ' + expected;
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
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.once('end', () => {
      const {program,args,cwd,stdin} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const child = require('node:child_process').spawn(program,args,{
        cwd,env:process.env,stdio:[stdin === undefined ? 'ignore' : 'pipe','inherit','inherit'],shell:false});
      if (child.stdin) {
        child.stdin.on('error',()=>process.exit(127));
        child.stdin.end(stdin);
      }
      child.on('error',()=>process.exit(127));
      child.on('exit',(code)=>process.exit(code ?? 128));
    });
  `;
  const payload = JSON.stringify({
    program: request.program,
    args: request.args,
    cwd: '/workspace' + (request.cwd ? '/' + request.cwd : ''),
    stdin: request.stdin,
  });
  if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('sandbox request too large');
  const observed: { cgroup: string | null } = { cgroup: null };
  let reason: SandboxEvidence['reason'] = 'exit';
  let output = Buffer.alloc(0);
  let truncated = false;
  let readyBuffer = '';
  let admitted = false;
  let closed = false;
  let stopping: Promise<void> | undefined;
  const nodeBinary = await realpath(process.execPath);
  request.signal?.throwIfAborted();
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
      ...sandboxArgv(request.root, script, request.mounts, nodeBinary),
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
  child.stdin.on('error', () => {
    reason = 'unavailable';
    void stop();
  });
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
          if (
            !path.startsWith('/user.slice/') ||
            basename(path) !== unit ||
            !path
              .slice(1)
              .split('/')
              .every((part) => /^[A-Za-z0-9_@-][A-Za-z0-9_.@-]*$/.test(part))
          )
            throw new Error('invalid cgroup');
          const events = await readFile('/sys/fs/cgroup' + path + '/cgroup.events', 'utf8');
          if (!populated(events, 1)) throw new Error('cgroup not populated');
          observed.cgroup = path;
          if (reason === 'exit' && !closed) child.stdin.end(payload);
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
      cleanupConfirmed = populated(events, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        const siblings = await readdir('/sys/fs/cgroup' + dirname(observed.cgroup)).catch(
          () => null,
        );
        cleanupConfirmed = siblings !== null && !siblings.includes(unit);
      }
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
