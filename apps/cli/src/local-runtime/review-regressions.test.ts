import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import {
  connectLocalRuntime,
  localRuntimePaths,
  readLocalRuntimeDescriptor,
} from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime, type LocalRuntimeHost } from './host.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), 'ocean-review-'));
  cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  runtime.close();
  return profile;
}
it('refuses a dangling restore guard before any endpoint publication', async () => {
  const profile = await fixture();
  const paths = localRuntimePaths(profile);
  symlinkSync(join(profile, 'missing-guard-target'), join(profile, 'restore-guard.json'));
  let published: LocalRuntimeHost | undefined;
  try {
    await expect(
      startLocalRuntime({ profile, provider: null }).then((host) => {
        published = host;
        return host;
      }),
    ).rejects.toThrow('restore_restricted');
    expect(existsSync(paths.descriptor)).toBe(false);
    expect(existsSync(paths.endpoint)).toBe(false);
  } finally {
    await published?.stop();
  }
});
it('terminates a rejected authenticated envelope before a coalesced stop can execute', async () => {
  const profile = await fixture();
  const host = await startLocalRuntime({ profile, provider: null });
  cleanups.push(async () => {
    await host.stop();
  });
  const observer = await connectLocalRuntime({ profile });
  cleanups.push(() => observer.close());
  const descriptor = readLocalRuntimeDescriptor(profile);
  const socket = connect(descriptor.endpoint);
  cleanups.push(() => {
    socket.destroy();
  });
  socket.on('error', () => {});
  const authenticated = new Promise<unknown>((resolve) =>
    socket.once('data', (bytes: Buffer) => resolve(JSON.parse(bytes.toString()))),
  );
  socket.write(JSON.stringify({ id: 'hello', method: 'hello', params: descriptor }) + '\n');
  expect(await authenticated).toMatchObject({
    result: { protocol: 1, instanceId: host.identity.instanceId },
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.write('{}\n' + JSON.stringify({ id: 'stop', method: 'stop', params: {} }) + '\n');
  await closed;
  expect(host.status().state).toBe('ready');
  expect((await observer.status()).state).toBe('ready');
});
