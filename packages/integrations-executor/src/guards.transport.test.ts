/**
 * Qualification gate and real-OpenAPI guard behaviour.
 *
 * Execution stays disabled by default, a pinned-chunk mismatch refuses, and
 * the advertised discovery/request caps are enforced against the actual
 * plugin surfaces.
 */
import { describe, expect, it } from 'vitest';

import { openApiPlugin } from '@executor-js/plugin-openapi/core';

import type { ExecutorHost } from './host-types.js';
import { verifyInstalledSdkChunk } from './pinned-identity.js';
import { createExecutorHost } from './sdk-boundary.js';
import { createTestTransport } from './test-support.js';
import { closeServer, listen, readBody, writeJson } from '../test-fixtures/loopback.js';
import {
  openApiAuthTemplates,
  openApiSpecJson,
  openApiSpecJsonWithOperations,
  startOpenApiService,
} from '../test-fixtures/openapi-service.js';
import {
  createSyntheticCounts,
  memoryProvider,
  syntheticPlugin,
} from '../test-fixtures/synthetic-plugin.js';

async function openSyntheticHost(catalog?: readonly unknown[]): Promise<{
  host: ExecutorHost;
  counts: ReturnType<typeof createSyntheticCounts>;
  business: Awaited<ReturnType<typeof listen>>;
  close: () => Promise<void>;
}> {
  const counts = createSyntheticCounts();
  const business = await listen((req, res) => {
    counts.business += 1;
    void readBody(req).then(() => writeJson(res, 200, { ok: true }));
  });
  const token = await listen((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const provider = memoryProvider();
  const host = await createExecutorHost({
    tenantId: 'probe-tenant',
    subjectId: 'probe-subject',
    allowedOrigins: [business.base, token.base],
    plugins: [
      syntheticPlugin({
        scenario: 'ok',
        businessBase: business.base,
        tokenBase: token.base,
        counts,
        ...(catalog === undefined ? {} : { catalog }),
      }),
    ],
    providers: [provider.provider],
  });
  await host.registerIntegration({
    pluginId: 'probe-integration',
    slug: 'probe',
    description: 'probe',
    config: {},
  });
  await host.createConnection({
    integrationId: 'probe',
    connectionId: 'work',
    owner: 'user',
    template: 'token',
    value: 'static-secret-1',
  });
  return {
    host,
    counts,
    business,
    close: async () => {
      await host.close();
      await Promise.all([closeServer(business.server), closeServer(token.server)]);
    },
  };
}

describe('qualification gate', () => {
  it('execution stays disabled by default and refuses without any network', async () => {
    const fixture = await openSyntheticHost();
    const transport = await createTestTransport(fixture.host);
    expect(transport.qualification().qualified).toBe(false);
    const target = { integrationId: 'probe', connectionId: 'work', owner: 'user' as const };
    const outcome = await transport.invoke(target, {
      invocationId: 'disabled',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(outcome).toMatchObject({ kind: 'not_started', code: 'execution_disabled' });
    await expect(transport.discover(target)).rejects.toMatchObject({ code: 'execution_disabled' });
    expect(fixture.counts.business).toBe(0);
    await transport.close();
    await fixture.close();
  });

  it('a pinned-chunk mismatch refuses execution (fail closed)', async () => {
    const fixture = await openSyntheticHost();
    const mismatched = {
      ...(await verifyInstalledSdkChunk()),
      ok: false,
      actualSha256: 'f'.repeat(64),
    };
    const transport = await createTestTransport(fixture.host, {
      enableExecution: true,
      identity: mismatched,
    });
    const target = { integrationId: 'probe', connectionId: 'work', owner: 'user' as const };
    const outcome = await transport.invoke(target, {
      invocationId: 'mismatch',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(outcome).toMatchObject({ kind: 'not_started', code: 'transport_unqualified' });
    await expect(transport.discover(target)).rejects.toMatchObject({
      code: 'transport_unqualified',
    });
    expect(fixture.counts.business).toBe(0);
    await transport.close();
    await fixture.close();
  });

  it('discovery refuses a catalog over the 256-tool cap', async () => {
    const huge = Array.from({ length: 257 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'synthetic',
      inputSchema: { type: 'object', properties: {} },
    }));
    const fixture = await openSyntheticHost(huge);
    const transport = await createTestTransport(fixture.host, {
      enableExecution: true,
    });
    await expect(
      transport.discover({ integrationId: 'probe', connectionId: 'work', owner: 'user' }),
    ).rejects.toMatchObject({ code: 'too_many_tools' });
    await transport.close();
    await fixture.close();
  });

  it('discovery refuses a catalog payload over the 4 MiB cap', async () => {
    const bigDescription = 'd'.repeat(20_000);
    const big = Array.from({ length: 240 }, (_, index) => ({
      name: `tool_${index}`,
      description: bigDescription,
      inputSchema: { type: 'object', properties: {} },
    }));
    const fixture = await openSyntheticHost(big);
    const transport = await createTestTransport(fixture.host, {
      enableExecution: true,
    });
    await expect(
      transport.discover({ integrationId: 'probe', connectionId: 'work', owner: 'user' }),
    ).rejects.toMatchObject({ code: 'discovery_too_large' });
    await transport.close();
    await fixture.close();
  });
});

describe('real OpenAPI transport guards', () => {
  it('refuses arguments over the 1 MiB request cap before dispatch', async () => {
    const service = await startOpenApiService('ok');
    const provider = memoryProvider();
    const host = await createExecutorHost({
      tenantId: 'probe-tenant',
      subjectId: 'probe-subject',
      allowedOrigins: [service.business.base, service.token.base],
      plugins: [openApiPlugin()],
      providers: [provider.provider],
    });
    await host.installOpenApi({
      integrationId: 'probe-api',
      name: 'Probe API',
      description: 'Synthetic',
      specJson: openApiSpecJson(service.business.base),
      authTemplates: openApiAuthTemplates.bearer,
    });
    await host.createConnection({
      integrationId: 'probe-api',
      connectionId: 'work',
      owner: 'user',
      template: 'bearer',
      value: 'static-secret-1',
    });
    const target = { integrationId: 'probe-api', connectionId: 'work', owner: 'user' as const };
    const transport = await createTestTransport(host, {
      enableExecution: true,
    });
    const catalog = await transport.discover(target);
    service.counts.business = 0;
    const outcome = await transport.invoke(target, {
      invocationId: 'oversize',
      tool: catalog.tools[0]?.name ?? '',
      arguments: { body: { value: 'y'.repeat(1024 * 1024 + 1) } },
    });
    expect(outcome).toMatchObject({ kind: 'not_started', code: 'arguments_too_large' });
    expect(service.counts.business).toBe(0);
    await transport.close();
    await service.close();
  });

  it('discovery refuses a real 300-operation catalog', async () => {
    const service = await startOpenApiService('ok');
    const provider = memoryProvider();
    const host = await createExecutorHost({
      tenantId: 'probe-tenant',
      subjectId: 'probe-subject',
      allowedOrigins: [service.business.base, service.token.base],
      plugins: [openApiPlugin()],
      providers: [provider.provider],
    });
    await host.installOpenApi({
      integrationId: 'probe-api',
      name: 'Probe API',
      description: 'Synthetic',
      specJson: openApiSpecJsonWithOperations(service.business.base, 300),
      authTemplates: openApiAuthTemplates.bearer,
    });
    await host.createConnection({
      integrationId: 'probe-api',
      connectionId: 'work',
      owner: 'user',
      template: 'bearer',
      value: 'static-secret-1',
    });
    const target = { integrationId: 'probe-api', connectionId: 'work', owner: 'user' as const };
    const transport = await createTestTransport(host, {
      enableExecution: true,
    });
    await expect(transport.discover(target)).rejects.toMatchObject({ code: 'too_many_tools' });
    await transport.close();
    await service.close();
  });
});
