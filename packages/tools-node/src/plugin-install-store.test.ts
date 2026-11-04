import {
  chmodSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SHIPPED_PLUGIN_CATALOG, canonicalJson } from '@runnets/domain';
import {
  createEnvironmentCredentialReferences,
  createPluginInstallStore,
  pluginManifestBytes,
} from './plugin-install-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
function store() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-plugin-install-'));
  roots.push(root);
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  return { root, profile, install: createPluginInstallStore({ profile }) };
}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('private verified plugin installation copy', () => {
  it('publishes canonical manifest bytes with 0700 directories and a 0600 file', () => {
    const { profile, install } = store();
    const file = install.publish('github', entry.version, entry.manifest);
    expect(file.sha256).toBe(entry.manifestDigest);
    expect(file).toMatchObject({ relativePath: 'manifest.json' });
    const directory = join(profile, 'plugins', 'github', entry.version);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    const manifest = join(directory, 'manifest.json');
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
    expect(digest(readFileSync(manifest))).toBe(entry.manifestDigest);
    expect(readFileSync(manifest).toString('utf8')).toBe(canonicalJson(entry.manifest));
    expect(install.read('github', entry.version)).toMatchObject({
      status: 'ok',
      sha256: entry.manifestDigest,
    });
    expect(pluginManifestBytes(entry.manifest).toString('utf8')).toBe(
      canonicalJson(entry.manifest),
    );
  });

  it('refuses to overwrite a published version and leaves a missing read explicit', () => {
    const { install } = store();
    install.publish('github', entry.version, entry.manifest);
    expect(() => install.publish('github', entry.version, entry.manifest)).toThrow(
      'install_conflict',
    );
    expect(install.read('github', '9.9.9')).toMatchObject({ status: 'missing' });
  });

  it('reports insecure or symlinked copies instead of trusting them', () => {
    const { profile, install } = store();
    install.publish('github', entry.version, entry.manifest);
    const manifest = join(profile, 'plugins', 'github', entry.version, 'manifest.json');
    writeFileSync(manifest, pluginManifestBytes(entry.manifest), { mode: 0o644 });
    chmodSync(manifest, 0o644);
    expect(install.read('github', entry.version).status).toBe('insecure');
    // A symlinked manifest is never followed.
    const outside = join(profile, 'outside.json');
    writeFileSync(outside, pluginManifestBytes(entry.manifest), { mode: 0o600 });
    rmSync(manifest);
    symlinkSync(outside, manifest);
    const read = install.read('github', entry.version);
    expect(read.status === 'ok').toBe(false);
  });

  it('sweeps only its own interrupted temp publications', () => {
    const { root, profile, install } = store();
    mkdirSync(join(profile, 'plugins'), { mode: 0o700 });
    mkdirSync(join(profile, 'plugins', '.tmp-' + 'a'.repeat(32)), { mode: 0o700 });
    mkdirSync(join(profile, 'plugins', '.tmp-' + 'b'.repeat(32)), { mode: 0o700 });
    mkdirSync(join(profile, 'plugins', 'keep'), { mode: 0o700 });
    expect(install.sweepInterrupted()).toBe(2);
    expect(install.read('github', entry.version).status).toBe('missing');
    void root;
  });

  it('repairs a corrupt version directory by atomically replacing it', () => {
    const { profile, install } = store();
    install.publish('github', entry.version, entry.manifest);
    const directory = join(profile, 'plugins', 'github', entry.version);
    const manifest = join(directory, 'manifest.json');
    chmodSync(manifest, 0o644);
    expect(install.read('github', entry.version).status).toBe('insecure');
    const repaired = install.repair('github', entry.version, entry.manifest);
    expect(repaired.sha256).toBe(entry.manifestDigest);
    expect(install.read('github', entry.version)).toMatchObject({ status: 'ok' });
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(join(profile, 'plugins', 'github')).filter((name) => name.startsWith('.tmp-')),
    ).toEqual([]);
  });

  it('never reads a credential value through the presence port', () => {
    const canary = 'CANARY_PLUGIN_REFERENCE_7f21';
    const references = createEnvironmentCredentialReferences({ OCEAN_TOKEN: canary });
    expect(references.available('OCEAN_TOKEN')).toBe(true);
    expect(references.available('MISSING_TOKEN')).toBe(false);
    expect(references.available('ghp_canaryValue')).toBe(false);
    expect(JSON.stringify(references.available('OCEAN_TOKEN'))).not.toContain(canary);
  });
});
