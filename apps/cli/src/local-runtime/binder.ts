// Fixed bootstrap programs. The child has private IPC (fd 3), a pinned endpoint
// directory (fd 4) and an empty application environment. No owner credential
// is available before, during or after the kernel binding check.
export const bindProgram = String.raw`
import errno, os, signal, socket, sys

signal.alarm(5)
os.umask(0o177)
path = '/proc/self/fd/4/runtime.sock'
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    listener.bind(path)
except OSError as error:
    sys.exit(3 if error.errno == errno.EADDRINUSE else 2)
listener.listen(64)
pin = os.open(path, os.O_PATH | os.O_NOFOLLOW)
os.close(4)

# An abstract socket address is a length-delimited byte string, including
# embedded NULs. The probe exclusively holds this address until after accept.
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
    address = b'\0ocean\0' + os.urandom(32)
    probe.bind(address)
    if probe.getsockname() != address:
        sys.exit(2)
    probe.settimeout(1)
    probe.connect('/proc/self/fd/' + str(pin))
    listener.settimeout(1)
    peer, peer_address = listener.accept()
    with peer:
        if peer_address != address:
            sys.exit(2)

# exec inherits these exact open file descriptions. No pathname lookup or
# second bind intervenes between verification and the Node IPC transfer.
listener.setblocking(False)
listener.set_inheritable(True)
os.set_inheritable(pin, True)
os.set_inheritable(3, True)
# Preserve Node's IPC bootstrap environment supplied by the parent's empty-env spawn.
os.execv(sys.argv[1], [sys.argv[1], '-e', sys.argv[2], str(listener.fileno()), str(pin)])
`;

// Adopt the verified listening FD with the public Node listen({fd}) API.
// Neither Node server binds a pathname, so closing either cannot unlink one.
export const transferProgram = String.raw`
  const { createServer } = require('node:net');
  const { fstatSync, readFileSync } = require('node:fs');
  process.once('disconnect', () => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
  const server = createServer(socket => socket.destroy());
  server.maxConnections = 1;
  server.once('error', () => process.exit(1));
  const pin = Number(process.argv[2]);
  server.listen({ fd: Number(process.argv[1]) }, () => {
    const stat = fstatSync(pin, { bigint: true });
    const mount = /^mnt_id:\s+(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + pin, 'utf8'))?.[1];
    if (!stat.isSocket() || !mount) process.exit(1);
    process.once('message', ack => process.exit(ack === 'pinned' ? 0 : 1));
    process.send([String(stat.dev), String(stat.ino), mount], server, error => {
      if (error) process.exit(1);
    });
  });
`;
