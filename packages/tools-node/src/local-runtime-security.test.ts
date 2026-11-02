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
import { LocalRuntimeFrames } from './local-runtime-framing.js';
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
