import { expect, it } from 'vitest';
import { createMcpDispatchGuard } from './mcp-dispatch-guard.js';
import { classifyDispatchExit } from './dispatch.js';

const body = (method: string) => new TextEncoder().encode(JSON.stringify({ method }));

it.each([400, 404, 503, null])(
  'retains the first attempt when SDK recovery follows %s',
  async (status) => {
    let requests = 0;
    const guard = createMcpDispatchGuard(() => {
      requests++;
      return status === null
        ? Promise.reject(new Error('reply lost'))
        : Promise.resolve(new Response('', { status }));
    });
    const send = (method: string) =>
      guard.fetch('http://fixture/mcp', { method: 'POST', body: body(method) });
    const exit = await guard.run(async () => {
      await send('tools/call').catch(() => undefined);
      await expect(send('tools/list')).rejects.toThrow('mcp_dispatch_recovery_refused');
      await expect(send('tools/call')).rejects.toThrow('mcp_dispatch_recovery_refused');
      return { ok: false, outcome: 'failure', tag: 'sdk_recovery_failed' };
    });
    expect(requests).toBe(1);
    expect(classifyDispatchExit('invocation', exit)).toMatchObject({
      kind: status !== null && status < 500 ? 'observed' : 'uncertain',
    });
  },
);

it('refuses implicit catalog setup before sending any business request', async () => {
  let requests = 0;
  const guard = createMcpDispatchGuard(() => {
    requests++;
    return Promise.resolve(new Response());
  });
  const exit = await guard.run(async () => {
    await expect(
      guard.fetch('http://fixture/mcp', {
        method: 'POST',
        body: body('server/discover'),
      }),
    ).rejects.toThrow('mcp_dispatch_recovery_refused');
    await expect(
      guard.fetch('http://fixture/mcp', { method: 'POST', body: body('tools/call') }),
    ).rejects.toThrow('mcp_dispatch_recovery_refused');
    return { ok: false, outcome: 'failure', tag: 'sdk_setup_failed' };
  });
  expect(requests).toBe(0);
  expect(classifyDispatchExit('invocation', exit)).toMatchObject({ kind: 'not_started' });
});

it('isolates the one-attempt allowance for concurrent invocations', async () => {
  let requests = 0;
  const guard = createMcpDispatchGuard(() => {
    requests++;
    return Promise.resolve(new Response());
  });
  await Promise.all(
    [1, 2].map(() =>
      guard.run(async () => {
        await guard.fetch('http://fixture/mcp', { method: 'POST', body: body('tools/call') });
        return { ok: true, value: 'done' };
      }),
    ),
  );
  expect(requests).toBe(2);
});
