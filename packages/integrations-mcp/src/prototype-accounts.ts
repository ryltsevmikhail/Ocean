import { InvocationSend } from './prototype-send.js';
import { client, empty, immutable } from './prototype-types.js';
import { httpTransport } from './prototype-http.js';
import { httpFixture } from './prototype-http-fixture.js';

// Two unrelated server instances publish incompatible tools with the same name.
export async function accountCase() {
  const r = empty('accounts');
  const a = await httpFixture('accounts-a');
  const b = await httpFixture('accounts-b');
  const left = client(true);
  const right = client(true);
  b.stats.version = 'bravo';
  let resume = () => {};
  let arrive = () => {};
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  try {
    const peers = [
      { c: left, f: a },
      { c: right, f: b },
    ];
    for (const { c, f } of peers) {
      await c.connect(
        httpTransport(f.url, async (url, init) => {
          if (new Headers(init?.headers).get('Mcp-Method') === 'tools/call') {
            r.sdkAttempts++;
            if (f === a) {
              arrive();
              await paused;
            }
            InvocationSend.current().admit();
            r.businessAttempts++;
          } else r.metadataAttempts++;
          return fetch(url, init);
        }),
        { timeout: 2000 },
      );
    }
    const invoke = async (c: typeof left, value: string) => {
      const tool = (await c.listTools(undefined, { cacheMode: 'refresh', timeout: 2000 })).tools[0];
      if (!tool) throw Error('missing tool');
      return new InvocationSend(2000).run(() =>
        c.callTool(
          { name: 'write', arguments: { value } },
          { toolDefinition: immutable(tool), timeout: 2000 },
        ),
      );
    };
    const old = invoke(left, 'alpha');
    try {
      await Promise.race([
        entered,
        old.then(() => {
          throw Error('unexpected early result');
        }),
      ]);
      const other = await invoke(right, 'bravo');
      if (other.isError) throw Error('other account refused');
    } finally {
      resume();
    }
    if ((await old).isError) throw Error('old account refused');
    r.observedEffects = a.stats.effects + b.stats.effects;
    r.outcome = 'observed';
    r.detail = JSON.stringify({ a: a.rows, b: b.rows, aHeaders: a.headers, bHeaders: b.headers });
    r.status =
      r.sdkAttempts === 2 &&
      r.businessAttempts === 2 &&
      r.observedEffects === 2 &&
      a.headers.join() === 'alpha' &&
      b.headers.join() === 'bravo' &&
      peers.every(({ f }) => f.rows.join() === 'server/discover,tools/list,tools/call')
        ? 'passed'
        : 'failed';
  } catch (e) {
    r.status = 'failed';
    r.detail = e instanceof Error ? e.message : 'exception';
  } finally {
    resume();
    await left.close();
    await right.close();
    await a.close();
    await b.close();
  }
  return r;
}
