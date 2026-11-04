/* eslint-disable no-restricted-imports -- Test-only host fixture for the desktop-asset suites. */
/**
 * Private host fixture shared by the desktop-asset test files: a disposable
 * HOME/XDG layout, a real SQLite profile with a group room, the local runtime,
 * an attached client and the Desktop attachment client.
 *
 * Split out of `desktop-assets.test.ts` to keep both suites inside the 300-line cap.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { connectLocalRuntime, DesktopAttachmentClient } from '@runnets/tools-node';
import { openOceanProfile } from '../src/ocean/profile.js';
import { startLocalRuntime } from '../src/local-runtime/host.js';
import { rooms } from './local-runtime-admission.test.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
});

/** Register one extra teardown step owned by the calling test. */
export function onCleanup(cleanup: () => unknown | Promise<unknown>): void {
  cleanups.push(cleanup);
}

export async function desktopAssetsFixture(alternate = false) {
  const root = mkdtempSync(join(tmpdir(), 'ocean-desktop-service-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const userData = join(root, 'userData'),
    home = join(root, 'home');
  mkdirSync(userData, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const run = join(root, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const profile = alternate ? join(root, 'alternate') : join(userData, 'conversation', 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const r = rooms(runtime.conversations);
  runtime.close();
  const host = await startLocalRuntime({ profile, provider: null });
  cleanups.push(() => host.stop());
  const client = await connectLocalRuntime({ profile });
  cleanups.push(() => client.close());
  const media = new DesktopAttachmentClient(client);
  return { root, profile, userData, room: r.groupId, client, host, media };
}
