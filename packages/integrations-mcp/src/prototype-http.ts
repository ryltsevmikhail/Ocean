import { httpTransport } from './profile.js';
export { httpTransport } from './profile.js';
import { InvocationSend } from './send.js';
import { ProtocolError, SdkError, SdkErrorCode, type Tool } from '@modelcontextprotocol/client';
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { client, empty, immutable, methodOf, type Case } from './prototype-types.js';
import { httpFixture } from './prototype-http-fixture.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export { httpCases } from './prototype-http-fixture.js';

export async function runHttpCase(name: string, dispatchFile?: string): Promise<Case> {
  const r = empty(name);
  const f = await httpFixture(name);
  const modern = !f.legacy;
  const held = name.startsWith('held-');
  const concurrent = name === 'held-concurrent' || name === 'status-race';
  const drained = deferred();
  const interrupt = new AbortController();
  let concurrentOutcome: Case['outcome'] = null;
  const c = client(modern);
  const gate = deferred();
  const entered = deferred();
  let notifications = 0;
  if (name === 'notification')
    c.setNotificationHandler('notifications/tools/list_changed', () => {
      notifications++;
    });
  let permitted = true;
  const statuses: Record<string, number> = {};
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
    const firstHeld = held && r.sdkAttempts === 1;
    try {
      if (r.sdkAttempts === 1 && (['catalog', 'revoked'].includes(name) || held)) {
        entered.resolve();
        await gate.promise;
      }
      if (!permitted) throw Error('revoked');
      const invocation = InvocationSend.current();
      invocation.admit(() => {
        if (dispatchFile) appendFileSync(dispatchFile, name + '\n', { flush: true, mode: 0o600 });
      });
      r.businessAttempts++;
      const request = fetch(url, init);
      if (name === 'post-revoke') permitted = false;
      const response = await request;
      invocation.httpStatus = response.status;
      return response;
    } finally {
      if (firstHeld) drained.resolve();
    }
  });
  const list = async () => {
    const tool = (await c.listTools(undefined, { cacheMode: 'refresh', timeout: 2000 })).tools[0];
    if (!tool) throw Error('missing definition');
    return immutable(tool);
  };
  async function call(tool: Tool, value: string) {
    const ac =
      (name === 'held-abort' || name === 'status-race') && value === 'alpha'
        ? interrupt
        : new AbortController();
    const timeout = held && value === 'alpha' ? 200 : name === 'timeout' ? 100 : 1800;
    const invocation = new InvocationSend(timeout, ac.signal);
    if (name === 'abort')
      void (async () => {
        while (!f.stats.effects && !ac.signal.aborted) await delay(1);
        ac.abort();
      })();
    try {
      const result = await invocation.run(() =>
        c.callTool(
          { name: 'write', arguments: { value } },
          { signal: ac.signal, timeout, toolDefinition: tool },
        ),
      );
      if (
        (result.structuredContent as { version?: unknown } | undefined)?.version !== value ||
        result.isError
      )
        matched = false;
      return 'observed' as const;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 180) : 'exception';
      return !invocation.sent
        ? ('not_started' as const)
        : [400, 401, 403, 404].includes(invocation.httpStatus) ||
            (e instanceof ProtocolError && [-32020, -32022].includes(e.code)) ||
            (e instanceof SdkError && e.code === SdkErrorCode.UnsupportedResultType)
          ? ('observed' as const)
          : ('uncertain' as const);
    } finally {
      statuses[value] = invocation.httpStatus;
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
    if (held || name === 'status-race') {
      if (held)
        await Promise.race([
          entered.promise,
          first.then(() => {
            throw Error('writer never reached hold');
          }),
        ]);
      else while (!f.stats.effects && !interrupt.signal.aborted) await delay(1);
      if (concurrent) concurrentOutcome = await call(tool, 'bravo');
      if (name === 'held-abort' || name === 'status-race') interrupt.abort();
      r.outcome = await first;
      gate.resolve();
      f.releaseResponse();
      if (held) await drained.promise;
      r.observedEffects = f.stats.effects;
      r.detail = JSON.stringify({
        protocol: observedProtocol,
        wire: f.rows,
        concurrentOutcome,
        concurrentStatus: statuses['bravo'],
        error,
        httpStatus: statuses['alpha'],
      });
      const sends = name === 'status-race' ? 2 : concurrent ? 1 : 0;
      r.status =
        r.sdkAttempts === (concurrent ? 2 : 1) &&
        r.businessAttempts === sends &&
        f.stats.calls === sends &&
        r.observedEffects === (name === 'status-race' ? 1 : 0) &&
        r.outcome === (held ? 'not_started' : 'uncertain') &&
        (!concurrent || concurrentOutcome === 'observed')
          ? 'passed'
          : 'failed';
      return r;
    }
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
      httpStatus: statuses['alpha'],
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
