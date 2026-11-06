import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServiceDecisions } from './service-decisions.js';
const text = JSON.stringify({
  executor: 'bot',
  operation: '<script>read()</script>',
  result: 'pending',
  detail: 'x'.repeat(40000),
});
const createdAt = Date.now();
const card = {
  workspaceId: 'ws_ocean',
  roomId: 'r',
  runId: 'run',
  decisionId: 'd',
  kind: 'service-call',
  status: 'pending',
  version: 1,
  createdAt,
  expiresAt: createdAt + 300000,
  bindingDigest: createHash('sha256').update(text).digest('hex'),
  previewLength: text.length,
};
it('requires complete SHA verified text and resolves the exact card; second owner sees the same terminal fact', async () => {
  let resolved = false;
  const request = vi.fn(async (c) => {
    if (c.op === 'service-decisions')
      return [{ ...card, status: resolved ? 'allowed' : 'pending', version: resolved ? 2 : 1 }];
    if (c.op === 'service-preview') return text;
    if (c.op === 'service-resolve') {
      resolved = true;
      return { ...card, status: 'allowed', version: 2 };
    }
    return { ...card, status: resolved ? 'allowed' : 'pending', version: resolved ? 2 : 1 };
  });
  const a = createServiceDecisions(request as never),
    b = createServiceDecisions(request as never);
  a.context('r');
  b.context('r');
  await a.load();
  await b.load();
  await a.inspect(card as never);
  expect(a.preview.value).toBe(text);
  expect(a.canResolve.value).toBe(true);
  await a.resolve('allow-once');
  await b.load();
  expect(b.cards.value[0]?.status).toBe('allowed');
  expect(request.mock.calls.find(([c]) => c.op === 'service-resolve')?.[0].input).toEqual({
    workspaceId: 'ws_ocean',
    roomId: 'r',
    runId: 'run',
    decisionId: 'd',
    expectedVersion: 1,
    bindingDigest: card.bindingDigest,
    choice: 'allow-once',
  });
  expect(a.canResolve.value).toBe(false);
});
it('rejects corrupt preview and stale room/window feedback', async () => {
  let finish!: (v: string) => void;
  const request = vi.fn(async (c) =>
    c.op === 'service-preview'
      ? new Promise((yes) => {
          finish = yes;
        })
      : card,
  );
  const s = createServiceDecisions(request as never);
  s.context('r');
  const work = s.inspect(card as never);
  await Promise.resolve();
  s.close();
  s.context('other');
  finish(text);
  await work;
  expect(s.preview.value).toBe('');
  expect(s.canResolve.value).toBe(false);
  const bad = createServiceDecisions(
    vi.fn(async (c) => (c.op === 'service-preview' ? 'bad' : card)) as never,
  );
  bad.context('r');
  await bad.inspect(card as never);
  expect(bad.canResolve.value).toBe(false);
  expect(bad.message.value).toContain('invalid_frame');
});
