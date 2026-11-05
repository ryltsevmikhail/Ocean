import {
  StreamableHTTPClientTransport,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type Tool,
} from '@modelcontextprotocol/client';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { client, empty, immutable, methodOf, type Case } from './prototype-types.js';
import { httpFixture } from './prototype-http-fixture.js';

type WireFetch = NonNullable<
  NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>['fetch']
>;
export function httpTransport(url: URL, wire: WireFetch, headers: Record<string, string> = {}) {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers, redirect: 'error' },
    fetch: wire,
    onInsufficientScope: 'throw',
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export const httpCases = [
  'json',
  'sse',
  'drop',
  '401',
  '403',
  '404',
  '500',
  'redirect',
  'protocol',
  'header',
  'input',
  'invalid',
  'timeout',
  'abort',
  'revoked',
  'post-revoke',
  'bad-schema',
  'catalog',
  'notification',
  'restart',
  'restart-drop',
] as const;

export async function runHttpCase(name: string, dispatchFile?: string): Promise<Case> {
  const r = empty(name);
  const f = await httpFixture(name);
  const modern = !['sse', 'notification'].includes(name);
  const c = client(modern);
  const gate = deferred();
  const entered = deferred();
  let notifications = 0;
  if (name === 'notification')
    c.setNotificationHandler('notifications/tools/list_changed', () => {
      notifications++;
    });
  let permitted = true;
  let status = 0;
  let catalogAtAdmission = 0;
  let expectedLists = 0;
  let matched = true;
  let error = '';
  let observedProtocol = '';
  const transport = httpTransport(f.url, async (url, init) => {
    const method = methodOf(init);
    if (method !== 'tools/call') {
      r.metadataAttempts++;
      return fetch(url, init);
    }
    r.sdkAttempts++;
    if (r.sdkAttempts === 1 && ['catalog', 'revoked'].includes(name)) {
      entered.resolve();
      await gate.promise;
    }
    if (!permitted) throw Error('revoked');
    if (dispatchFile) appendFileSync(dispatchFile, name + '\n', { flush: true, mode: 0o600 });
    r.businessAttempts++;
    const request = fetch(url, init);
    if (name === 'post-revoke') permitted = false;
    const response = await request;
    status = response.status;
    return response;
  });
  const list = async () => {
    const tool = (await c.listTools(undefined, { cacheMode: 'refresh', timeout: 2000 })).tools[0];
    if (!tool) throw Error('missing definition');
    return immutable(tool);
  };
  async function call(tool: Tool, value: string) {
    const ac = new AbortController();
    if (name === 'abort')
      void (async () => {
        while (!f.stats.effects && !ac.signal.aborted) await delay(1);
        ac.abort();
      })();
    try {
      const result = await c.callTool(
        { name: 'write', arguments: { value } },
        { signal: ac.signal, timeout: name === 'timeout' ? 100 : 1800, toolDefinition: tool },
      );
      if (
        (result.structuredContent as { version?: unknown } | undefined)?.version !== value ||
        result.isError
      )
        matched = false;
      return 'observed' as const;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 180) : 'exception';
      return !r.businessAttempts
        ? ('not_started' as const)
        : [400, 401, 403, 404].includes(status) ||
            (e instanceof ProtocolError && [-32020, -32022].includes(e.code)) ||
            (e instanceof SdkError && e.code === SdkErrorCode.UnsupportedResultType)
          ? ('observed' as const)
          : ('uncertain' as const);
    } finally {
      ac.abort();
    }
  }
  try {
    await c.connect(transport, { timeout: 2000 });
    observedProtocol = c.getNegotiatedProtocolVersion() ?? '';
    let tool = await list();
    if (name === 'bad-schema')
      tool = immutable({
        ...tool,
        outputSchema: { type: 'object', properties: { broken: { $ref: 'urn:missing' } } },
      });
    catalogAtAdmission = f.rows.length;
    const first = call(tool, 'alpha');
    if (['catalog', 'revoked'].includes(name)) {
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw Error('call missed controlled boundary');
        }),
      ]);
      if (name === 'revoked') permitted = false;
      else {
        f.stats.version = 'bravo';
        const newer = await list();
        expectedLists++;
        // The new definition has a different input header and incompatible output.
        if ((await call(newer, 'bravo')) !== 'observed') matched = false;
      }
      gate.resolve();
    }
    r.outcome = await first;
    if (name === 'notification') {
      if ((await call(tool, 'alpha')) !== 'observed') matched = false;
      await delay(500);
    }
    if (name === 'restart' || name === 'restart-drop') {
      await c.close();
      const fresh = client(modern);
      try {
        await fresh.connect(
          httpTransport(f.url, async (url, init) => {
            if (methodOf(init) === 'tools/call') r.sdkAttempts++;
            else r.metadataAttempts++;
            return fetch(url, init);
          }),
          { timeout: 2000 },
        );
        await fresh.listTools(undefined, { cacheMode: 'refresh', timeout: 2000 });
        expectedLists++;
      } finally {
        await fresh.close();
      }
    }
    const before = name === 'revoked' || name === 'bad-schema';
    const two = name === 'catalog' || name === 'notification';
    const expectedCalls = before ? 0 : two ? 2 : 1;
    const expectedEffects = [
      'revoked',
      'bad-schema',
      '401',
      '403',
      '404',
      '500',
      'protocol',
      'header',
      'input',
      'redirect',
    ].includes(name)
      ? 0
      : two
        ? 2
        : 1;
    const expectedOutcome = before
      ? 'not_started'
      : ['drop', 'restart-drop', '500', 'invalid', 'timeout', 'abort', 'redirect'].includes(name)
        ? 'uncertain'
        : 'observed';
    const tail = f.rows.slice(catalogAtAdmission);
    const lists = tail.filter((x) => x === 'tools/list').length;
    const discovery = tail.filter((x) => x === 'initialize' || x === 'server/discover').length;
    r.observedEffects = f.stats.effects;
    r.detail = JSON.stringify({
      protocol: observedProtocol,
      wire: f.rows,
      headers: f.headers,
      responseTypes: f.types,
      httpStatus: status,
      notified: notifications,
      error,
    });
    r.status =
      matched &&
      r.outcome === expectedOutcome &&
      r.sdkAttempts === (name === 'bad-schema' ? 0 : before ? 1 : expectedCalls) &&
      r.businessAttempts === expectedCalls &&
      f.stats.calls === expectedCalls &&
      r.observedEffects === expectedEffects &&
      lists === expectedLists &&
      discovery === (name.startsWith('restart') ? 1 : 0) &&
      (name !== 'catalog' || f.headers.join(',') === 'bravo,alpha') &&
      (name !== 'notification' || notifications === 2) &&
      (name !== 'sse' || f.types[0]?.startsWith('text/event-stream')) &&
      (name !== 'json' || f.types[0]?.startsWith('application/json'))
        ? 'passed'
        : 'failed';
  } catch (e) {
    r.status = 'failed';
    r.detail = JSON.stringify({
      wire: f.rows,
      error: e instanceof Error ? e.message : 'exception',
    });
  } finally {
    gate.resolve();
    await c.close();
    await f.close();
  }
  return r;
}
