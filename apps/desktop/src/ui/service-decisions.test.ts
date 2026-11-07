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
it('retains bounded continuation after 1000 mixed cards so the next pending service call is reachable', async () => {
  const all = Array.from({ length: 1001 }, (_, i) => ({
    ...card,
    decisionId: 'd' + String(i).padStart(4, '0'),
    kind: i === 1000 ? 'service-call' : 'write',
  }));
  const request = vi.fn(async (c) => {
    const after = c.input.after ? Number(c.input.after.slice(1)) + 1 : 0;
    return all.slice(after, after + 50);
  });
  const s = createServiceDecisions(request as never);
  s.context('r');
  await s.load();
  expect(request).toHaveBeenCalledTimes(20);
  expect(s.cards.value).toHaveLength(0);
  expect(s.cursor.value).toBe('d0999');
  expect(s.exhausted.value).toBe(false);
  await s.loadMore();
  expect(s.cards.value[0]?.decisionId).toBe('d1000');
  expect(request.mock.calls.at(-1)?.[0].input.after).toBe('d0999');
});
it('does not publish an old room continuation after context changes, or reuse its cursor in the new room', async () => {
  let finish!: (v: unknown[]) => void;
  const requests: { input: { roomId: string; after?: string } }[] = [];
  const request = vi.fn(async (c) => {
    requests.push(c);
    if (c.input.roomId === 'old')
      return new Promise<unknown[]>((resolve) => {
        finish = resolve;
      });
    return [];
  });
  const s = createServiceDecisions(request as never);
  s.context('old');
  const old = s.load();
  s.context('new');
  await s.load();
  finish([{ ...card, roomId: 'old' }]);
  await old;
  expect(s.cards.value).toEqual([]);
  expect(s.cursor.value).toBeNull();
  expect(s.exhausted.value).toBe(true);
  expect(requests.map((r) => r.input)).toEqual([
    { workspaceId: 'ws_ocean', roomId: 'old', limit: 50 },
    { workspaceId: 'ws_ocean', roomId: 'new', limit: 50 },
  ]);
});
it('reports a stale exact decision as refused without silently resolving a newer version', async () => {
  let writes = 0;
  const request = vi.fn(async (c) => {
    if (c.op === 'service-preview') return text;
    if (c.op === 'service-decisions') return [{ ...card, version: 2 }];
    if (c.op === 'service-resolve') {
      ++writes;
      throw Error('version_conflict');
    }
    return card;
  });
  const state = createServiceDecisions(request as never);
  state.context('r');
  await state.inspect(card as never);
  await state.resolve('allow-once');
  expect(writes).toBe(1);
  expect(state.canResolve.value).toBe(false);
  expect(state.message.value).toContain('Устаревшее решение отклонено');
});
it('refuses a different run or decision returned for an exact scoped reference before preview or vote', async () => {
  const request = vi.fn(async (c) =>
    c.op === 'service-decision' ? { ...card, runId: 'foreign' } : text,
  );
  const state = createServiceDecisions(request as never);
  state.context('r');
  await state.inspect(card as never);
  expect(state.canResolve.value).toBe(false);
  expect(state.message.value).toContain('invalid_frame');
  expect(request.mock.calls.map(([c]) => c.op)).toEqual(['service-decision']);
});
