import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  chmodSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import {
  connectLocalRuntime,
  localRuntimePaths,
  readLocalRuntimeDescriptor,
} from '@runnets/tools-node';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { createTaskRun } from '../acp/session.js';
import { taskRunId } from '@runnets/domain';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-local-'));
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  runtime.close();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, profile };
}
async function host(profile: string) {
  const h = await startLocalRuntime({ profile, provider: null });
  cleanups.push(async () => {
    await h.stop();
  });
  return h;
}
async function raw(profile: string, messages: unknown[]) {
  const d = readLocalRuntimeDescriptor(profile);
  const socket = connect(d.endpoint);
  const output: unknown[] = [];
  let pending = '';
  const result = new Promise<unknown[]>((resolve, reject) => {
    socket.on('data', (b: Buffer) => {
      pending += b.toString();
      let n;
      while ((n = pending.indexOf('\n')) >= 0) {
        output.push(JSON.parse(pending.slice(0, n)));
        pending = pending.slice(n + 1);
        if (output.length === messages.length) {
          socket.destroy();
          resolve(output);
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(output));
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(Error('timeout'));
    });
  });
  for (const message of messages) {
    const frame = JSON.stringify(message) + '\n';
    socket.write(frame.slice(0, 3));
    socket.write(frame.slice(3));
  }
  return result;
}
it('serves two authenticated clients with one SQLite owner and detaches independently', async () => {
  const { profile } = await fixture();
  const h = await host(profile);
  const a = await connectLocalRuntime({ profile });
  const b = await connectLocalRuntime({ profile });
  expect(a.identity.instanceId).toBe(b.identity.instanceId);
  expect(a.identity.protocol).toBe(1);
  expect((await a.status()).state).toBe('ready');
  await expect(startLocalRuntime({ profile, provider: null })).rejects.toMatchObject({
    code: 'owner_busy',
  });
  a.close();
  expect((await b.status()).instanceId).toBe(h.identity.instanceId);
  b.close();
  const c = await connectLocalRuntime({ profile });
  expect(await c.stop()).toMatchObject({ state: 'stopped', outcome: 'complete' });
  c.close();
  await h.closed;
  expect(() => readLocalRuntimeDescriptor(profile)).toThrow('runtime_absent');
});
it('recovers interrupted state before publishing a ready endpoint', async () => {
  const { profile } = await fixture();
  const runtime = openOceanProfile(profile);
  await runtime.ready;
  await createTaskRun({
    service: runtime.service,
    taskRunId: taskRunId('tr_lost'),
    conversationId: 'cv_lost',
    workspaceId: 'ws_lost',
    model: 'fake',
    parentTaskRunId: null,
  });
  runtime.close();
  const h = await host(profile);
  expect(h.recovery.tasks).toMatchObject([{ taskRunId: 'tr_lost', status: 'reconciling' }]);
  const c = await connectLocalRuntime({ profile });
  expect((await c.status()).state).toBe('ready');
  c.close();
});
it.each(['capability', 'profileId', 'protocol', 'instanceId'])(
  'refuses a wrong %s handshake before status',
  async (field) => {
    const { profile } = await fixture();
    await host(profile);
    const d = readLocalRuntimeDescriptor(profile);
    const params = {
      protocol: 1,
      profileId: d.profileId,
      instanceId: d.instanceId,
      capability: d.capability,
      [field]: 'wrong',
    };
    expect(await raw(profile, [{ id: 'one', method: 'hello', params }])).toMatchObject([
      { error: { code: field === 'protocol' ? 'protocol_mismatch' : 'authentication_failed' } },
    ]);
  },
);
it('requires hello, rejects future methods and handles fragmented frames', async () => {
  const { profile } = await fixture();
  await host(profile);
  const d = readLocalRuntimeDescriptor(profile);
  expect(await raw(profile, [{ id: 'one', method: 'status', params: {} }])).toMatchObject([
    { error: { code: 'authentication_required' } },
  ]);
  expect(
    await raw(profile, [
      { id: 'hello', method: 'hello', params: d },
      { id: 'later', method: 'submit', params: {} },
    ]),
  ).toMatchObject([{ result: { protocol: 1 } }, { error: { code: 'method_not_found' } }]);
});
it('rejects an oversized frame without affecting another observer', async () => {
  const { profile } = await fixture();
  await host(profile);
  const d = readLocalRuntimeDescriptor(profile);
  const socket = connect(d.endpoint);
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('error', () => {});
  socket.write('x'.repeat(2 * 1024 * 1024 + 1));
  await closed;
  const c = await connectLocalRuntime({ profile });
  expect((await c.status()).state).toBe('ready');
  c.close();
});
it('uses private modes and preserves a foreign replacement on shutdown', async () => {
  const { profile } = await fixture();
  const h = await host(profile);
  const p = localRuntimePaths(profile);
  expect(lstatSync(p.directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(p.descriptor).mode & 0o777).toBe(0o600);
  expect(lstatSync(p.endpoint).mode & 0o777).toBe(0o600);
  unlinkSync(p.descriptor);
  writeFileSync(p.descriptor, 'foreign', { mode: 0o600 });
  await h.stop();
  expect(readFileSync(p.descriptor, 'utf8')).toBe('foreign');
  rmSync(p.directory, { recursive: true, force: true });
});
it('refuses restored profiles before publishing an endpoint', async () => {
  const { profile } = await fixture();
  writeFileSync(join(profile, 'restore-guard.json'), '{}', { mode: 0o600 });
  await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
    'restore_restricted',
  );
  expect(() => readLocalRuntimeDescriptor(profile)).toThrow('runtime_absent');
});
it('refuses insecure and symlink profiles', async () => {
  const { root, profile } = await fixture();
  chmodSync(profile, 0o755);
  await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow(
    'insecure_permissions',
  );
  chmodSync(profile, 0o700);
  const alias = join(root, 'alias');
  symlinkSync(profile, alias);
  await expect(startLocalRuntime({ profile: alias, provider: null })).rejects.toThrow(
    'insecure_permissions',
  );
});
it('refuses stale files without unlinking them', async () => {
  const { profile } = await fixture();
  const p = localRuntimePaths(profile);
  mkdirSync(p.directory, { recursive: true, mode: 0o700 });
  cleanups.push(() => rmSync(p.directory, { recursive: true, force: true }));
  writeFileSync(p.endpoint, 'foreign', { mode: 0o600 });
  await expect(startLocalRuntime({ profile, provider: null })).rejects.toThrow('endpoint_exists');
  expect(readFileSync(p.endpoint, 'utf8')).toBe('foreign');
});

it('refuses a missing capability without exposing status', async () => {
  const { profile } = await fixture();
  await host(profile);
  const d = readLocalRuntimeDescriptor(profile);
  expect(
    await raw(profile, [
      {
        id: 'missing',
        method: 'hello',
        params: { protocol: 1, profileId: d.profileId, instanceId: d.instanceId },
      },
    ]),
  ).toMatchObject([{ error: { code: 'authentication_failed' } }]);
});
