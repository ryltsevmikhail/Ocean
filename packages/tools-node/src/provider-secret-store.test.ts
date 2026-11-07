import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProviderSecretStore,
  providerCredentialDirectory,
  PROVIDER_SECRET_FILE,
} from './provider-secret-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-secrets-'));
  roots.push(root);
  const directory = join(root, 'profile.credentials');
  return { root, directory, store: createProviderSecretStore(directory) };
}
const REF_A = 'psec_' + 'a'.repeat(32);
const REF_B = 'psec_' + 'b'.repeat(32);
const KEY_A = 'sk-fixture-store-key-a';

describe('provider credential store', () => {
  it('creates a 0700 directory and a 0600 file outside the profile directory', () => {
    const f = fixture();
    expect(f.store.read(REF_A)).toEqual({ status: 'absent' });
    f.store.write(REF_A, KEY_A);
    expect(statSync(f.directory).mode & 0o777).toBe(0o700);
    const file = join(f.directory, PROVIDER_SECRET_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(f.store.read(REF_A)).toEqual({ status: 'ok', key: KEY_A });
    const body = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(body).toEqual({ version: 1, secrets: { [REF_A]: { key: KEY_A } } });
    expect(readdirSync(f.directory)).toEqual([PROVIDER_SECRET_FILE]);
    expect(JSON.stringify(readdirSync(f.directory))).not.toContain(KEY_A);
  });

  it('rotates and removes opaque references without losing the other ones', () => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    f.store.write(REF_B, 'sk-fixture-store-key-b');
    expect(f.store.read(REF_A)).toEqual({ status: 'ok', key: KEY_A });
    expect(f.store.read(REF_B)).toEqual({ status: 'ok', key: 'sk-fixture-store-key-b' });
    f.store.remove(REF_A);
    expect(f.store.read(REF_A)).toEqual({ status: 'absent' });
    expect(f.store.read(REF_B)).toEqual({ status: 'ok', key: 'sk-fixture-store-key-b' });
    f.store.remove(REF_A);
    expect(f.store.read(REF_B).status).toBe('ok');
  });

  it('replaces the previous value in one atomic publication and keeps it on failure', () => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    f.store.replace(REF_A, REF_B, 'sk-fixture-store-key-b');
    expect(f.store.read(REF_A)).toEqual({ status: 'absent' });
    expect(f.store.read(REF_B)).toEqual({ status: 'ok', key: 'sk-fixture-store-key-b' });
    const body = JSON.parse(readFileSync(join(f.directory, PROVIDER_SECRET_FILE), 'utf8')) as {
      secrets: Record<string, unknown>;
    };
    expect(Object.keys(body.secrets)).toEqual([REF_B]);
    chmodSync(f.directory, 0o500);
    try {
      expect(() => f.store.replace(REF_B, REF_A, KEY_A)).toThrow();
    } finally {
      chmodSync(f.directory, 0o700);
    }
    expect(f.store.read(REF_B)).toEqual({ status: 'ok', key: 'sk-fixture-store-key-b' });
    expect(f.store.read(REF_A)).toEqual({ status: 'absent' });
  });

  it('leaves an interrupted publication inert and never infers a value from a temp file', () => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    writeFileSync(join(f.directory, '.providers-deadbeef.tmp'), '{"key":"partial"', {
      mode: 0o600,
    });
    expect(f.store.read(REF_A)).toEqual({ status: 'ok', key: KEY_A });
    const fresh = createProviderSecretStore(f.directory);
    expect(fresh.read(REF_A)).toEqual({ status: 'ok', key: KEY_A });
  });

  it('reports an explicit unverified state for a malformed or insecure file', () => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    const file = join(f.directory, PROVIDER_SECRET_FILE);
    writeFileSync(file, 'not-json', { mode: 0o600 });
    expect(f.store.read(REF_A)).toEqual({
      status: 'unverified',
      reason: 'provider_secret_corrupt',
    });
    writeFileSync(file, JSON.stringify({ version: 2, secrets: {} }), { mode: 0o600 });
    expect(f.store.read(REF_A)).toEqual({
      status: 'unverified',
      reason: 'provider_secret_corrupt',
    });
    writeFileSync(file, JSON.stringify({ version: 1, secrets: { [REF_A]: { key: 7 } } }), {
      mode: 0o600,
    });
    expect(f.store.read(REF_A)).toEqual({
      status: 'unverified',
      reason: 'provider_secret_corrupt',
    });
    writeFileSync(file, JSON.stringify({ version: 1, secrets: { [REF_A]: { key: KEY_A } } }));
    chmodSync(file, 0o644);
    expect(f.store.read(REF_A)).toEqual({
      status: 'unverified',
      reason: 'provider_secret_insecure',
    });
    chmodSync(file, 0o600);
    chmodSync(f.directory, 0o755);
    expect(f.store.read(REF_A)).toEqual({
      status: 'unverified',
      reason: 'provider_secret_insecure',
    });
    expect(() => f.store.write(REF_B, KEY_A)).toThrow('insecure_permissions');
  });

  it('refuses a symlinked or foreign file instead of following it', () => {
    const f = fixture();
    mkdirSync(f.directory, { mode: 0o700 });
    const outside = join(f.root, 'outside.json');
    writeFileSync(outside, JSON.stringify({ version: 1, secrets: { [REF_A]: { key: KEY_A } } }), {
      mode: 0o600,
    });
    symlinkSync(outside, join(f.directory, PROVIDER_SECRET_FILE));
    expect(f.store.read(REF_A)).toEqual({
      status: 'unverified',
      reason: 'provider_secret_insecure',
    });
    expect(() => f.store.remove(REF_A)).toThrow('insecure_permissions');
  });

  it('keeps the previous published value when a write cannot complete', () => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    chmodSync(f.directory, 0o500);
    try {
      expect(() => f.store.write(REF_B, 'sk-fixture-store-key-b')).toThrow();
    } finally {
      chmodSync(f.directory, 0o700);
    }
    expect(f.store.read(REF_A)).toEqual({ status: 'ok', key: KEY_A });
    expect(f.store.read(REF_B)).toEqual({ status: 'absent' });
  });

  it('refuses removal of an unreadable shared file without replacing its bytes', () => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    const file = join(f.directory, PROVIDER_SECRET_FILE);
    writeFileSync(file, 'broken', { mode: 0o600 });
    expect(() => f.store.remove(REF_A)).toThrow('provider_write_failed');
    expect(readFileSync(file, 'utf8')).toBe('broken');
    expect(f.store.read(REF_A).status).toBe('unverified');
  });

  it('rejects references and values outside the bounded private format', () => {
    const f = fixture();
    expect(() => f.store.write('not-a-ref', KEY_A)).toThrow('invalid_input');
    expect(() => f.store.write(REF_A, '')).toThrow('invalid_input');
    expect(() => f.store.write(REF_A, 'x'.repeat(513))).toThrow('invalid_input');
    expect(f.store.read('../providers.json')).toEqual({
      status: 'unverified',
      reason: 'provider_secret_corrupt',
    });
    expect(() => createProviderSecretStore('relative/dir')).toThrow('invalid_input');
  });

  it('derives a sibling credentials directory from the profile path deterministically', () => {
    expect(providerCredentialDirectory('/home/user/.local/share/ocean-rc/profile')).toBe(
      '/home/user/.local/share/ocean-rc/profile.credentials',
    );
    expect(providerCredentialDirectory('/tmp/root/profile')).toBe('/tmp/root/profile.credentials');
    expect(() => providerCredentialDirectory('relative/profile')).toThrow('invalid_input');
    expect(() => providerCredentialDirectory('/tmp/root/../profile')).toThrow('invalid_input');
  });
});
it('refuses capacity overflow before publication and atomically retires only the superseded service entry', () => {
  const f = fixture();
  f.store.write(REF_A, 'A'.repeat(512));
  f.store.write(REF_B, KEY_A);
  const file = join(f.directory, PROVIDER_SECRET_FILE);
  const body = JSON.parse(readFileSync(file, 'utf8')) as {
    version: number;
    secrets: Record<string, { key: string }>;
  };
  let n = 0,
    last = '';
  while (Buffer.byteLength(JSON.stringify(body) + '\n') < 65000) {
    last = 'psec_' + String(++n).padStart(32, '0');
    body.secrets[last] = { key: 'P'.repeat(512) };
  }
  const bytes = Buffer.byteLength(JSON.stringify(body) + '\n');
  if (bytes > 65536) body.secrets[last]!.key = 'P'.repeat(512 - (bytes - 65500));
  writeFileSync(file, JSON.stringify(body) + '\n');
  const original = readFileSync(file);
  expect(() => f.store.write('psec_' + 'c'.repeat(32), 'C'.repeat(512))).toThrow(
    'provider_write_failed',
  );
  expect(readFileSync(file)).toEqual(original);
  expect(f.store.read(REF_B)).toEqual({ status: 'ok', key: KEY_A });
  f.store.replace(REF_A, 'psec_' + 'c'.repeat(32), 'C'.repeat(512));
  expect(f.store.read(REF_A)).toEqual({ status: 'absent' });
  expect(f.store.read(REF_B)).toEqual({ status: 'ok', key: KEY_A });
  expect(f.store.read('psec_' + 'c'.repeat(32))).toEqual({ status: 'ok', key: 'C'.repeat(512) });
});
it.each(['corrupt', 'oversized', 'insecure'])(
  'ordinary mutations preserve %s shared private bytes',
  (fault) => {
    const f = fixture();
    f.store.write(REF_A, KEY_A);
    const file = join(f.directory, PROVIDER_SECRET_FILE);
    if (fault === 'corrupt') writeFileSync(file, '{corrupt');
    if (fault === 'oversized') writeFileSync(file, ' '.repeat(65537));
    if (fault === 'insecure') chmodSync(file, 0o644);
    const before = readFileSync(file);
    for (const mutate of [
      () => f.store.write(REF_B, 'synthetic'),
      () => f.store.replace(REF_A, REF_B, 'synthetic'),
      () => f.store.remove(REF_A),
    ]) {
      expect(mutate).toThrow();
      expect(readFileSync(file)).toEqual(before);
    }
  },
);
