import { bindProgram, transferProgram } from './binder.js';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, chmodSync } from 'node:fs';
import { Server, type Socket } from 'node:net';
import { mount, type EndpointLayout } from './endpoint-files.js';

export async function bindListener(layout: EndpointLayout, connected: (socket: Socket) => void) {
  layout.entries([]);
  const child = spawn(
    '/usr/bin/python3',
    ['-I', '-S', '-c', bindProgram, process.execPath, transferProgram],
    {
      cwd: '/',
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', layout.directoryFd],
    },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(Error('endpoint_verification_unavailable')));
    child.once('close', resolve);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5500);
  let server: Server | undefined, pin: number | undefined;
  let matched = false,
    ready = false;
  try {
    await Promise.race([
      exited.then((code) => {
        if (code === 3) throw Error('endpoint_exists');
        throw Error(code === 2 ? 'endpoint_changed' : 'endpoint_verification_unavailable');
      }),
      new Promise<void>((resolve, reject) =>
        child.once('message', (identity: unknown, handle) => {
          try {
            if (!(handle instanceof Server)) throw Error('endpoint_changed');
            server = handle;
            server.maxConnections = 64;
            server.on('connection', (socket: Socket) => {
              if (ready) connected(socket);
              else socket.destroy();
            });
            layout.check();
            pin = layout.pin('runtime.sock');
            const stat = fstatSync(pin, { bigint: true });
            if (
              !stat.isSocket() ||
              !Array.isArray(identity) ||
              identity.length !== 3 ||
              identity[0] !== String(stat.dev) ||
              identity[1] !== String(stat.ino) ||
              identity[2] !== mount(pin) ||
              !layout.matches('runtime.sock', pin) ||
              (stat.mode & 0o7777n) !== 0o600n ||
              stat.nlink !== 1n ||
              stat.uid !== BigInt(process.getuid!())
            )
              throw Error('endpoint_changed');
            child.send('pinned', (err) => (err ? reject(Error('endpoint_changed')) : resolve()));
          } catch (error) {
            reject(error instanceof Error ? error : Error('endpoint_changed'));
          }
        }),
      ),
    ]);
    if ((await exited) !== 0 || pin === undefined || !server) throw Error('endpoint_changed');
    matched = true;
    chmodSync('/proc/self/fd/' + pin, 0o600);
    if (!layout.matches('runtime.sock', pin)) throw Error('endpoint_changed');
    return {
      server,
      socketFd: pin,
      activate: () => {
        ready = true;
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => {});
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (pin !== undefined) {
      try {
        if (matched && layout.matches('runtime.sock', pin)) layout.unlink('runtime.sock', pin);
      } finally {
        closeSync(pin);
      }
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
