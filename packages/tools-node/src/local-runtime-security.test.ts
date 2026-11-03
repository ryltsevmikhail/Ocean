import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localRuntimePaths,
  prepareLocalRuntimePaths,
  readLocalRuntimeDescriptor,
} from './local-runtime-paths.js';
import { LocalRuntimeFrames, writeLocalRuntimeFrame } from './local-runtime-framing.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const clean of cleanups.splice(0).reverse()) clean();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-endpoint-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile'),
    runtimeRoot = join(root, 'run');
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(runtimeRoot, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', runtimeRoot);
  return { root, profile, runtimeRoot };
}
it('does not classify a dangling descriptor symlink as runtime absence', () => {
  const { root, profile } = fixture();
  const paths = localRuntimePaths(profile);
  prepareLocalRuntimePaths(paths);
  symlinkSync(join(root, 'missing'), paths.descriptor);
  expect(() => readLocalRuntimeDescriptor(profile)).toThrow('insecure_permissions');
});
it('does not classify a foreign socket entry without a descriptor as runtime absence', () => {
  const { profile } = fixture();
  const paths = localRuntimePaths(profile);
  prepareLocalRuntimePaths(paths);
  writeFileSync(paths.endpoint, 'foreign', { mode: 0o600 });
  expect(() => readLocalRuntimeDescriptor(profile)).toThrow('endpoint_exists');
});
it('treats a missing socket with a descriptor as unreachable rather than absent', () => {
  const { profile } = fixture();
  const paths = localRuntimePaths(profile);
  prepareLocalRuntimePaths(paths);
  writeFileSync(
    paths.descriptor,
    JSON.stringify({
      protocol: 1,
      profileId: paths.profileId,
      instanceId: '11111111-1111-1111-1111-111111111111',
      endpoint: paths.endpoint,
      capability: 'a'.repeat(64),
    }),
    { mode: 0o600 },
  );
  expect(() => readLocalRuntimeDescriptor(profile)).toThrow('runtime_unreachable');
});
it('refuses an insecure runtime parent without repairing its permissions', () => {
  const { profile, runtimeRoot } = fixture();
  chmodSync(runtimeRoot, 0o755);
  expect(() => localRuntimePaths(profile)).toThrow('insecure_permissions');
});
it('uses a verified short fallback for an overlong XDG path and keeps profile identity', () => {
  const { root, profile } = fixture();
  const short = localRuntimePaths(profile);
  const long = join(root, 'x'.repeat(90));
  mkdirSync(long, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', long);
  const paths = localRuntimePaths(profile);
  expect(paths.profileId).toBe(short.profileId);
  expect(paths.root).toBe('/tmp/ocean-' + process.getuid?.());
  expect(Buffer.byteLength(paths.endpoint)).toBeLessThanOrEqual(103);
  expect(existsSync(paths.directory)).toBe(false);
});
it('decodes fragmented UTF-8 bytes and independent coalesced frames', () => {
  const received: unknown[] = [];
  const frames = new LocalRuntimeFrames((value) => received.push(value));
  const bytes = Buffer.from('{"text":"🌊"}\n{"number":2}\n');
  for (const byte of bytes) frames.push(Buffer.from([byte]));
  expect(received).toEqual([{ text: '🌊' }, { number: 2 }]);
});
it('bounds each frame independently and rejects invalid UTF-8', () => {
  const frames = new LocalRuntimeFrames(() => {});
  expect(() => frames.push(Buffer.from([0xff, 10]))).toThrow('invalid_frame');
  const more = new LocalRuntimeFrames(() => {});
  expect(() => more.push(Buffer.from('"' + 'x'.repeat(2 * 1024 * 1024)))).toThrow(
    'frame_too_large',
  );
});

it.each(['symlink', 'mode', 'hardlink'])(
  'refuses a %s descriptor before reading its credential',
  (kind) => {
    const { root, profile } = fixture();
    const paths = localRuntimePaths(profile);
    prepareLocalRuntimePaths(paths);
    const foreign = join(root, 'foreign');
    writeFileSync(foreign, 'private', { mode: 0o600 });
    if (kind === 'symlink') symlinkSync(foreign, paths.descriptor);
    else if (kind === 'hardlink') linkSync(foreign, paths.descriptor);
    else writeFileSync(paths.descriptor, 'private', { mode: 0o644 });
    expect(() => readLocalRuntimeDescriptor(profile)).toThrow('insecure_permissions');
  },
);

it.each(['profile', 'runtime'])(
  'rejects a private %s below a replaceable non-sticky ancestor',
  (kind) => {
    const { root, profile } = fixture();
    const unsafe = join(root, 'unsafe');
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    const privateChild = join(unsafe, kind);
    mkdirSync(privateChild, { mode: 0o700 });
    if (kind === 'runtime') vi.stubEnv('XDG_RUNTIME_DIR', privateChild);
    expect(() => localRuntimePaths(kind === 'profile' ? privateChild : profile)).toThrow(
      'insecure_permissions',
    );
  },
);
it('preserves a private layout under a trusted sticky temporary ancestor', () => {
  const { profile } = fixture();
  const paths = localRuntimePaths(profile);
  expect(() => prepareLocalRuntimePaths(paths)).not.toThrow();
});
it('terminal consumer rejection prevents coalesced and later frame dispatch', () => {
  const received: unknown[] = [];
  const frames = new LocalRuntimeFrames((value) => {
    received.push(value);
    return false;
  });
  frames.push(Buffer.from('{}\n{"method":"stop"}\n'));
  frames.push(Buffer.from('{"method":"status"}\n'));
  expect(received).toEqual([{}]);
});
it('writes an exact 2MiB JSON frame plus its delimiter to a draining peer', async () => {
  const { root } = fixture();
  let received = 0;
  const server = createServer((socket) =>
    socket.on('data', (b: Buffer) => {
      received += b.length;
    }),
  );
  const endpoint = join(root, 'boundary.sock');
  await new Promise<void>((r) => server.listen(endpoint, r));
  const socket = connect(endpoint);
  await once(socket, 'connect');
  try {
    writeLocalRuntimeFrame(socket, 'x'.repeat(2 * 1024 * 1024 - 2));
    expect(socket.destroyed).toBe(false);
    await vi.waitFor(() => expect(received).toBe(2 * 1024 * 1024 + 1));
  } finally {
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it('refuses a partial publication directory containing only a staged descriptor', () => {
  const { profile } = fixture();
  const paths = localRuntimePaths(profile);
  prepareLocalRuntimePaths(paths);
  writeFileSync(join(paths.directory, '.connection-partial'), 'canary', { mode: 0o600 });
  expect(() => readLocalRuntimeDescriptor(profile)).toThrow('endpoint_exists');
});
