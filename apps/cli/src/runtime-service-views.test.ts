import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { httpFixture } from '../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { composeRuntimeServices } from './runtime-services.js';
it('live readiness disappears on session retirement while durable active/catalog facts remain and reads perform no discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'service-view-')),
    store = openSqliteStore({ path: ':memory:' }),
    http = await httpFixture('normal');
  const services = composeRuntimeServices({
    profile: join(root, 'profile'),
    store,
    ownerId: 'owner',
    clock: { now: () => new Date() },
    restored: false,
  });
  try {
    await services.start();
    services.owner.setConnection({
      requestId: 'set',
      connectionId: 'test',
      expectedVersions: null,
      name: 'Test',
      configuration: { kind: 'http', url: http.url.href },
      metadataPermission: 'allow',
    });
    const before = http.rows.length;
    expect(services.owner.connections()).toMatchObject([{ readiness: 'metadata_required' }]);
    expect(http.rows).toHaveLength(before);
    await services.owner.refreshConnection({
      requestId: 'refresh',
      connectionId: 'test',
      expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
    });
    const discovered = http.rows.length;
    expect(services.owner.connections()).toMatchObject([
      { state: 'active', readiness: 'ready', tools: ['write'] },
    ]);
    expect(services.owner.grants()).toEqual([]);
    expect(http.rows).toHaveLength(discovered);
    await services.drain();
    const retired = http.rows.length;
    expect(services.owner.connections()).toMatchObject([
      { state: 'active', readiness: 'unavailable', tools: ['write'] },
    ]);
    expect(http.rows).toHaveLength(retired);
    expect(http.stats.calls).toBe(0);
    expect(http.stats.effects).toBe(0);
  } finally {
    await services.drain();
    await http.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
