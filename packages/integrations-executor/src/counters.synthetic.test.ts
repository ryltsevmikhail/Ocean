/**
 * Request-counter evidence for the pinned patch, measured through the public
 * transport port (not directly through the SDK).
 *
 * Every scenario counts ACTUAL business HTTP requests. The load-bearing claim:
 * one allowed invocation causes exactly one business request, including after
 * an upstream 401, and never a reactive token refresh; a dropped response is
 * classified `uncertain` and never retried.
 */
import { describe, expect, it } from 'vitest';

import { createExecutorHost } from './sdk-boundary.js';
import { createTestTransport } from './test-support.js';
import type { ExecutorServicePluginTransport } from './transport.js';
import type { ExecutorHost } from './host-types.js';
import {
  createSyntheticCounts,
  memoryProvider,
  syntheticPlugin,
} from '../test-fixtures/synthetic-plugin.js';
import type { SyntheticScenario } from '../test-fixtures/synthetic-plugin.js';
import { closeServer, listen, readBody, sleep, writeJson } from '../test-fixtures/loopback.js';

interface Harness {
  readonly host: ExecutorHost;
  readonly transport: ExecutorServicePluginTransport;
  readonly counts: ReturnType<typeof createSyntheticCounts>;
  readonly target: { integrationId: string; connectionId: string; owner: 'user' };
  reset(): void;
  close(): Promise<void>;
}

async function openHarness(
  scenario: SyntheticScenario,
  onElicitationRequest?: (tag: string, source: string) => void,
): Promise<Harness> {
  const counts = createSyntheticCounts();

  const business = await listen((req, res) => {
    counts.business += 1;
    void readBody(req).then(() => {
      if (scenario === 'drop') {
        req.socket.destroy();
        return;
      }
      if (scenario === 'slow') {
        setTimeout(() => writeJson(res, 200, { ok: true, wrote: true }), 600);
        return;
      }
      const auth = req.headers.authorization ?? '';
      const stale = auth === 'Bearer oauth-access-1' || auth === 'Bearer static-secret-1';
      if (
        scenario === 'double401' ||
        ((scenario === 'oauth401' || scenario === 'static401') && stale)
      ) {
        writeJson(res, 401, { message: 'token expired' });
        return;
      }
      writeJson(res, 200, { ok: true, wrote: true });
    });
  });

  const token = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const location = new URL(url.searchParams.get('redirect_uri') ?? 'http://127.0.0.1:9/');
      location.searchParams.set('code', 'probe-code-1');
      location.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      void readBody(req).then((body) => {
        counts.token += 1;
        const grant = new URLSearchParams(body).get('grant_type') ?? 'authorization_code';
        counts.grants.push(grant);
        writeJson(res, 200, {
          access_token: grant === 'refresh_token' ? 'oauth-access-2' : 'oauth-access-1',
          refresh_token: grant === 'refresh_token' ? 'oauth-refresh-2' : 'oauth-refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read',
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const provider = memoryProvider();
  const host = await createExecutorHost({
    tenantId: 'probe-tenant',
    subjectId: 'probe-subject',
    allowedOrigins: [business.base, token.base],
    redirectUri: 'http://127.0.0.1:9/oauth/callback',
    testOnlyOAuthSetupFetch: fetch,
    plugins: [
      syntheticPlugin({ scenario, businessBase: business.base, tokenBase: token.base, counts }),
    ],
    providers: [provider.provider],
    firstPartyOAuthClients: [
      {
        name: 'probe-as',
        authorizationUrl: `${token.base}/authorize`,
        tokenUrl: `${token.base}/token`,
        clientId: 'probe-client',
        clientSecret: 'probe-secret',
      },
    ],
    ...(onElicitationRequest === undefined ? {} : { onElicitationRequest }),
  });

  await host.registerIntegration({
    pluginId: 'probe-integration',
    slug: 'probe',
    description: 'Synthetic probe integration',
    config: {},
  });

  const wantsOAuth = scenario === 'oauth401' || scenario === 'double401';
  if (wantsOAuth) {
    await host.createOAuthConnection({
      integrationId: 'probe',
      connectionId: 'work',
      template: 'oauth',
      clientSlug: 'first-party:probe-as',
    });
  } else {
    await host.createConnection({
      integrationId: 'probe',
      connectionId: 'work',
      owner: 'user',
      template: 'token',
      value: 'static-secret-1',
    });
  }

  const transport = await createTestTransport(host, { enableExecution: true });
  return {
    host,
    transport,
    counts,
    target: { integrationId: 'probe', connectionId: 'work', owner: 'user' },
    reset() {
      counts.business = 0;
      counts.token = 0;
      counts.grants = [];
    },
    async close() {
      await transport.close();
      await Promise.all([closeServer(business.server), closeServer(token.server)]);
    },
  };
}

const invocation = (id: string) => ({
  invocationId: id,
  tool: 'write_thing',
  arguments: { value: 'x' },
});

describe('pinned Executor SDK dispatch counters (synthetic plugin, real loopback)', () => {
  it('refreshable OAuth 401: exactly one business request and zero reactive refreshes', async () => {
    const harness = await openHarness('oauth401');
    harness.reset();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-oauth401'));
    expect(harness.counts.business).toBe(1);
    expect(harness.counts.grants.filter((grant) => grant === 'refresh_token')).toHaveLength(0);
    expect(outcome.kind).toBe('observed');
    expect(outcome.vendorErrorCode).toBe('connection_rejected');
    await harness.close();
  });

  it('static credential 401: exactly one business request', async () => {
    const harness = await openHarness('static401');
    harness.reset();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-static401'));
    expect(harness.counts.business).toBe(1);
    expect(harness.counts.token).toBe(0);
    expect(outcome).toMatchObject({ kind: 'observed', vendorErrorCode: 'connection_rejected' });
    await harness.close();
  });

  it('double 401: exactly one business request, no second attempt', async () => {
    const harness = await openHarness('double401');
    harness.reset();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-double401'));
    expect(harness.counts.business).toBe(1);
    expect(harness.counts.grants.filter((grant) => grant === 'refresh_token')).toHaveLength(0);
    expect(outcome.kind).toBe('observed');
    await harness.close();
  });

  it('dropped response after a server-side write: one request, uncertain, no retry', async () => {
    const harness = await openHarness('drop');
    harness.reset();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-drop'));
    expect(harness.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'transport_failure' });
    await sleep(100);
    expect(harness.counts.business).toBe(1);
    await harness.close();
  });

  it('success: one business request and an observed result', async () => {
    const harness = await openHarness('ok');
    harness.reset();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-ok'));
    expect(harness.counts.business).toBe(1);
    expect(outcome.kind).toBe('observed');
    expect(outcome.code).toBe('ok');
    await harness.close();
  });

  it('two invocations cause two requests: one dispatch per invocation', async () => {
    const harness = await openHarness('ok');
    harness.reset();
    await harness.transport.invoke(harness.target, invocation('inv-a'));
    await harness.transport.invoke(harness.target, invocation('inv-b'));
    expect(harness.counts.business).toBe(2);
    await harness.close();
  });

  it('per-call deadline: one business request, uncertain deadline_exceeded', async () => {
    const harness = await openHarness('slow');
    harness.reset();
    const startedAt = Date.now();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-slow'), {
      deadlineMs: 150,
    });
    const elapsed = Date.now() - startedAt;
    expect(harness.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'deadline_exceeded' });
    expect(elapsed).toBeLessThan(2_000);
    await harness.close();
  });

  it('caller cancellation mid-flight: one business request, uncertain interrupted', async () => {
    const harness = await openHarness('slow');
    harness.reset();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-abort'), {
      signal: controller.signal,
      deadlineMs: 5_000,
    });
    expect(harness.counts.business).toBe(1);
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'interrupted' });
    await harness.close();
  });

  it('tool-originated elicitation is declined and never dispatched', async () => {
    const requests: { tag: string; source: string }[] = [];
    const harness = await openHarness('elicit', (tag, source) => requests.push({ tag, source }));
    harness.reset();
    const outcome = await harness.transport.invoke(harness.target, invocation('inv-elicit'));
    expect(requests).toEqual([{ tag: 'FormElicitation', source: 'tool' }]);
    expect(harness.counts.elicitDeclined).toBe(1);
    expect(harness.counts.business).toBe(0);
    // A declined mid-call request is not a returned business result.
    expect(outcome.kind).toBe('uncertain');
    await harness.close();
  });
});
