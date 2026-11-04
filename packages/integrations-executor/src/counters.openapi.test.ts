/**
 * Real `@executor-js/plugin-openapi@1.6.11` transport counters.
 *
 * One allowed invocation must cause exactly one business POST, including after
 * an upstream 401 (the patched replay trigger) and after a dropped response.
 * Setup/discovery GETs are counted on the same server but are not business
 * POSTs, so a mistaken replay cannot hide behind discovery traffic.
 */
import { describe, expect, it } from 'vitest';

import { openApiPlugin } from '@executor-js/plugin-openapi/core';

import { createExecutorHost } from './sdk-boundary.js';
import type { ExecutorHost } from './host-types.js';
import { createTestTransport } from './test-support.js';
import type { ExecutorServicePluginTransport } from './transport.js';
import {
  openApiAuthTemplates,
  openApiSpecJson,
  startOpenApiService,
} from '../test-fixtures/openapi-service.js';
import type { OpenApiScenario } from '../test-fixtures/openapi-service.js';
import { memoryProvider } from '../test-fixtures/synthetic-plugin.js';

interface Harness {
  readonly service: Awaited<ReturnType<typeof startOpenApiService>>;
  readonly host: ExecutorHost;
  readonly transport: ExecutorServicePluginTransport;
  readonly target: { integrationId: string; connectionId: string; owner: 'user' };
  readonly toolName: string;
  readonly elicitationRequests: { tag: string; source: string }[];
  reset(): void;
  close(): Promise<void>;
}

async function openHarness(scenario: OpenApiScenario): Promise<Harness> {
  const service = await startOpenApiService(scenario);
  const provider = memoryProvider();
  const wantsOAuth = scenario === 'oauth401';
  const elicitationRequests: { tag: string; source: string }[] = [];

  const host = await createExecutorHost({
    tenantId: 'probe-tenant',
    subjectId: 'probe-subject',
    allowedOrigins: [service.business.base, service.token.base],
    plugins: [openApiPlugin()],
    providers: [provider.provider],
    redirectUri: 'http://127.0.0.1:9/oauth/callback',
    testOnlyOAuthSetupFetch: fetch,
    onElicitationRequest: (tag, source) => elicitationRequests.push({ tag, source }),
    firstPartyOAuthClients: [
      {
        name: 'probe-as',
        authorizationUrl: `${service.token.base}/authorize`,
        tokenUrl: `${service.token.base}/token`,
        clientId: 'probe-client',
        clientSecret: 'probe-secret',
      },
    ],
  });

  await host.installOpenApi({
    integrationId: 'probe-api',
    name: 'Probe API',
    description: 'Synthetic OpenAPI service',
    specJson: openApiSpecJson(service.business.base),
    authTemplates: wantsOAuth
      ? openApiAuthTemplates.oauth2(service.token.base)
      : openApiAuthTemplates.bearer,
  });

  if (wantsOAuth) {
    await host.createOAuthConnection({
      integrationId: 'probe-api',
      connectionId: 'work',
      template: 'oauth',
      clientSlug: 'first-party:probe-as',
    });
  } else {
    await host.createConnection({
      integrationId: 'probe-api',
      connectionId: 'work',
      owner: 'user',
      template: 'bearer',
      value: 'static-secret-1',
    });
  }

  const target = { integrationId: 'probe-api', connectionId: 'work', owner: 'user' as const };
  const transport = await createTestTransport(host, { enableExecution: true });
  const catalog = await transport.discover(target);
  const tool = catalog.tools.find((candidate) => candidate.name.endsWith('writeThing'));
  if (tool === undefined)
    throw new Error(`writeThing not discovered: ${JSON.stringify(catalog.tools)}`);

  return {
    service,
    host,
    transport,
    target,
    toolName: tool.name,
    elicitationRequests,
    reset() {
      service.counts.business = 0;
      service.counts.token = 0;
      service.counts.grants = [];
      service.counts.attacker = 0;
    },
    async close() {
      await transport.close();
      await service.close();
    },
  };
}

const invocation = (id: string, tool: string) => ({
  invocationId: id,
  tool,
  arguments: { body: { value: 'x' } },
});

describe('real OpenAPI plugin dispatch counters', () => {
  it('success: exactly one business POST', async () => {
    const harness = await openHarness('ok');
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-ok', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'observed', code: 'ok' });
    await harness.close();
  });

  it('static credential 401: exactly one business POST, observed auth rejection', async () => {
    const harness = await openHarness('static401');
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-static401', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'observed', vendorErrorCode: 'connection_rejected' });
    await harness.close();
  });

  it('refreshable OAuth 401: exactly one business POST and zero refresh grants (patched)', async () => {
    const harness = await openHarness('oauth401');
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-oauth401', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(harness.service.counts.grants.filter((grant) => grant === 'refresh_token')).toHaveLength(
      0,
    );
    expect(outcome).toMatchObject({ kind: 'observed', vendorErrorCode: 'connection_rejected' });
    await harness.close();
  });

  it('dropped response after a server-side write: one POST, uncertain, no retry', async () => {
    const harness = await openHarness('drop');
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-drop', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'transport_failure' });
    expect(harness.service.counts.business).toBe(1);
    await harness.close();
  });

  it('cross-origin redirect: rejected, zero requests reach the attacker origin', async () => {
    const harness = await openHarness('redirect');
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-redirect', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(harness.service.counts.attacker).toBe(0);
    expect(outcome.kind).toBe('uncertain');
    await harness.close();
  });

  it('discovery is stable and bounded: two discoveries return the same schema digest', async () => {
    const harness = await openHarness('ok');
    const first = await harness.transport.discover(harness.target);
    const second = await harness.transport.discover(harness.target);
    expect(first.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.schemaDigest).toBe(second.schemaDigest);
    expect(first.tools.length).toBeLessThanOrEqual(256);
    await harness.close();
  });

  it('an SDK policy-approval gate is accepted for the exact dispatch (one request)', async () => {
    const harness = await openHarness('ok');
    harness.elicitationRequests.length = 0;
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-policy', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(outcome.kind).toBe('observed');
    // The SDK's own consent gate for the selected call is the only accepted
    // elicitation; it must be bound to the in-flight address/args.
    expect(harness.elicitationRequests).toEqual([{ tag: 'FormElicitation', source: 'policy' }]);
    await harness.close();
  });

  it('upstream 5xx: exactly one POST, uncertain upstream_failure, no retry', async () => {
    const harness = await openHarness('server500');
    harness.reset();
    const outcome = await harness.transport.invoke(
      harness.target,
      invocation('openapi-500', harness.toolName),
    );
    expect(harness.service.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'upstream_failure' });
    await harness.close();
  });
});
