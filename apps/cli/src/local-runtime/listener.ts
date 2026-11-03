import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, chmodSync } from 'node:fs';
import { connect, Server, type Socket } from 'node:net';
import { mount, type EndpointLayout } from './endpoint-files.js';

// libuv unlinks the original bind pathname on close. Transfer the listening FD, then
// exit without uv_close. The owner's received handle has no unlink pathname. fd 4 is
// the pinned directory, fd 3 private parent IPC. Neither side sends a credential.
const bindProgram = `
  const { createServer } = require('node:net');
  const { constants, openSync, fstatSync, readFileSync } = require('node:fs');
  process.once('disconnect', () => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
  const server = createServer(socket => socket.destroy());
  server.maxConnections = 1;
  server.once('error', () => process.exit(1));
  process.umask(0o177);
  const path = '/proc/self/fd/4/runtime.sock';
  server.listen(path, () => {
    const pin = openSync(path,0x200000|constants.O_NOFOLLOW);
    const stat = fstatSync(pin,{bigint:true});
    const mount = /^mnt_id:\\s+(\\d+)$/m.exec(readFileSync('/proc/self/fdinfo/'+pin,'utf8'))?.[1];
    if (!stat.isSocket() || !mount) process.exit(1);
    process.once('message',ack => process.exit(ack === 'pinned' ? 0 : 1));
    process.send([String(stat.dev),String(stat.ino),mount], server, error => { if(error) process.exit(1); });
  });
`;
export async function bindListener(layout: EndpointLayout, connected: (socket: Socket) => void) {
  layout.entries([]);
  const child = spawn(process.execPath, ['-e', bindProgram], {
    cwd: '/',
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', layout.directoryFd],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5500);
  let server: Server | undefined, pin: number | undefined;
  let matched = false,
    ready = false;
  const challenge = randomBytes(32);
  let checking = true;
  try {
    await Promise.race([
      exited.then(() => {
        throw Error('endpoint_exists');
      }),
      new Promise<void>((resolve, reject) =>
        child.once('message', (identity: unknown, handle) => {
          try {
            if (!(handle instanceof Server)) throw Error('endpoint_changed');
            server = handle;
            server.maxConnections = 64;
            server.on('connection', (socket: Socket) => {
              if (ready) connected(socket);
              else if (checking) {
                socket.on('error', () => socket.destroy());
                socket.end(challenge, () => socket.destroy());
              } else socket.destroy();
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
    await verifyBinding(pin, challenge);
    checking = false;
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

// Check that this specific open filesystem inode reaches our received listener.
// No data or authentication capability is sent to a substituted socket.
async function verifyBinding(pin: number, challenge: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect('/proc/self/fd/' + pin);
    let received = 0;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      if (ok) resolve();
      else reject(Error('endpoint_changed'));
    };
    const timer = setTimeout(() => finish(false), 1000);
    socket.on('data', (bytes: Buffer) => {
      if (!bytes.equals(challenge.subarray(received, received + bytes.length)))
        return finish(false);
      received += bytes.length;
    });
    socket.once('end', () => finish(received === challenge.length));
    socket.once('error', () => finish(false));
  });
}
