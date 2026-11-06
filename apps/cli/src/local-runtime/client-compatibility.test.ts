import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LOCAL_PLUGIN_SESSION_AUTHORITY, LOCAL_SERVICE_CONFIRMATIONS } from '@runnets/contracts';
import { connectLocalRuntime, readLocalRuntimeDescriptor } from '@runnets/tools-node';
import { isLocalRuntimeIdentity as rc2Accepts } from '../../test-fixtures/rc2-runtime-contract.js';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { RuntimePlugins } from './plugins.js';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oc-compat-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const offline = openOceanProfile(profile, true);
  await offline.ready;
  offline.close();
  const host = await startLocalRuntime({ profile, provider: null });
  cleanups.push(() => host.stop());
  const descriptor = readLocalRuntimeDescriptor(profile);
  const raw = async (params: unknown, methods = ['status']) => {
    const socket = connect(descriptor.endpoint);
    let text = '';
    const replies: { result?: unknown; error?: { code: string } }[] = [];
    return new Promise<typeof replies>((resolve, reject) => {
      socket.on('data', (bytes: Buffer) => {
        text += bytes.toString();
        let end;
        while ((end = text.indexOf('\n')) >= 0) {
          replies.push(JSON.parse(text.slice(0, end)));
          text = text.slice(end + 1);
        }
        if (replies.length === methods.length + 1) socket.end();
      });
      socket.on('close', () => resolve(replies));
      socket.on('error', reject);
      socket.setTimeout(2000, () => socket.destroy(Error('test wire timeout')));
      socket.write(JSON.stringify({ id: 'hello', method: 'hello', params }) + '\n');
      for (const method of methods)
        socket.write(JSON.stringify({ id: method, method, params: {} }) + '\n');
    });
  };
  return { profile, descriptor, raw };
}
it('negotiates plugin-free RC2 hello/status and refuses plugin calls before dispatch', async () => {
  const { descriptor, raw } = await fixture();
  const dispatch = vi.spyOn(RuntimePlugins.prototype, 'dispatch');
  const [hello, status, plugin, future] = await raw(descriptor, [
    'status',
    'plugin.catalog',
    'future.operation',
  ]);
  expect(rc2Accepts(hello?.result)).toBe(true);
  expect(status?.result).toMatchObject({ ...(hello?.result as object), state: 'ready' });
  expect(
    (hello?.result as { capabilities: string[] }).capabilities.some((c) => c.startsWith('plugin.')),
  ).toBe(false);
  expect((hello?.result as { capabilities: string[] }).capabilities).not.toContain(
    LOCAL_SERVICE_CONFIRMATIONS,
  );
  expect(plugin?.error?.code).toBe('plugin_runtime_upgrade_required');
  expect(future?.error?.code).toBe('method_not_found');
  expect(dispatch).not.toHaveBeenCalled();
});
it('current client advertises authority support and keeps plugin transport', async () => {
  const { profile } = await fixture();
  const client = await connectLocalRuntime({ profile });
  try {
    expect(client.identity.capabilities).toContain(LOCAL_PLUGIN_SESSION_AUTHORITY);
    expect(client.identity.capabilities).toContain(LOCAL_SERVICE_CONFIRMATIONS);
    expect(client.identity.capabilities).toContain('room.addressed-history-v1');
    expect(client.identity.capabilities.slice(0, 2)).toEqual(['status', 'stop']);
    expect(client.identity.capabilities.length).toBeLessThanOrEqual(80);
    expect((await client.status()).capabilities).toEqual(client.identity.capabilities);
    const dispatch = vi.spyOn(RuntimePlugins.prototype, 'dispatch');
    await client.pluginCatalog({});
    expect(dispatch).toHaveBeenCalledWith('plugin.catalog', {});
  } finally {
    client.close();
  }
});
it.each([null, 'feature', [1], [''], ['x'.repeat(65)], Array(17).fill('future')])(
  'rejects malformed or unbounded clientFeatures: %j',
  async (clientFeatures) => {
    const { descriptor, raw } = await fixture();
    expect(await raw({ ...descriptor, clientFeatures }, [])).toMatchObject([
      { error: { code: 'invalid_params' } },
    ]);
  },
);
it('unknown bounded features do not enable plugin operations', async () => {
  const { descriptor, raw } = await fixture();
  const [hello, plugin] = await raw({ ...descriptor, clientFeatures: ['future'] }, [
    'plugin.catalog',
  ]);
  expect(rc2Accepts(hello?.result)).toBe(true);
  expect((hello?.result as { capabilities: string[] }).capabilities).not.toContain(
    'room.addressed-history-v1',
  );
  expect(plugin?.error?.code).toBe('plugin_runtime_upgrade_required');
});
it('negotiates service confirmations independently of plugin, model and service settings support', async () => {
  const { descriptor, raw } = await fixture();
  const [hello, status] = await raw({
    ...descriptor,
    clientFeatures: [LOCAL_SERVICE_CONFIRMATIONS],
  });
  const capabilities = (hello?.result as { capabilities: string[] }).capabilities;
  expect(capabilities).toContain(LOCAL_SERVICE_CONFIRMATIONS);
  expect(
    capabilities.some(
      (c) => c.startsWith('plugin.') || c.startsWith('service.') || c === 'model.connections-v1',
    ),
  ).toBe(false);
  expect(status?.result).toMatchObject({ ...(hello?.result as object), state: 'ready' });
});
it('negotiates addressed history without enabling independent plugin, model or service support', async () => {
  const { descriptor, raw } = await fixture();
  const [hello, status] = await raw({
    ...descriptor,
    clientFeatures: ['room.addressed-history-v1'],
  });
  const capabilities = (hello?.result as { capabilities: string[] }).capabilities;
  expect(capabilities).toContain('room.addressed-history-v1');
  expect(capabilities.slice(0, 2)).toEqual(['status', 'stop']);
  expect(capabilities.length).toBeLessThanOrEqual(80);
  expect(
    capabilities.some(
      (c) =>
        c.startsWith('plugin.') ||
        c.startsWith('service.') ||
        c === 'model.connections-v1' ||
        c === 'decisions.service-v1',
    ),
  ).toBe(false);
  expect(status?.result).toMatchObject({ ...(hello?.result as object), state: 'ready' });
});
