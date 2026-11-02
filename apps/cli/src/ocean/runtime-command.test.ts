import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOceanCommand } from './command.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { openOceanProfile } from './profile.js';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function command(profile: string, args: string[]) {
  const output = new PassThrough();
  let text = '';
  output.on('data', (b: Buffer) => {
    text += b.toString();
  });
  const code = await runOceanCommand(['runtime', ...args, '--profile', profile, '--json'], {
    output,
    error: new PassThrough(),
  });
  return { code, data: JSON.parse(text) };
}
it('status and stop use the socket while the database has an exclusive owner', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ocean-rt-command-'));
  cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  runtime.close();
  const host = await startLocalRuntime({ profile, provider: null });
  cleanups.push(async () => {
    await host.stop();
  });
  expect(await command(profile, ['status'])).toMatchObject({
    code: 0,
    data: { ok: true, data: { state: 'ready', instanceId: host.identity.instanceId } },
  });
  expect(await command(profile, ['stop'])).toMatchObject({
    code: 0,
    data: { data: { state: 'stopped', outcome: 'complete' } },
  });
});
it('absent status never creates a database', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'ocean-rt-absent-'));
  cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
  expect(await command(profile, ['status'])).toMatchObject({
    code: 3,
    data: { error: { code: 'runtime_absent' } },
  });
  expect(existsSync(join(profile, 'runtime.sqlite'))).toBe(false);
});
