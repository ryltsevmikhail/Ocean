import { Client } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admission, connection } from '../test-fixtures/admission.js';
import { httpFixture } from './prototype-http-fixture.js';
import { createMcpServiceTransport } from './index.js';
import { SessionWriter } from './session-writer.js';
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { open, wait };
}

it.each(['business', 'metadata'])(
  'suspends a held %s writer when a different session cannot confirm retirement',
  async (mode) => {
    const f = await httpFixture('json'),
      dir = await mkdtemp(join(tmpdir(), 'mcp-suspension-'));
    const enter = latch(),
      resume = latch();
    const t = createMcpServiceTransport({
      protocol: '2026-07-28',
      prepareDispatch: async () => {
        enter.open();
        await resume.wait;
      },
    });
    const c = connection({ kind: 'http', url: f.url.href });
    const a = admission(join(dir, 'db'), c, t);
    const discover = () =>
      t.discover(c, {
        authorizeMetadata: () => a.metadata(c),
        deadlineMs: 3000,
        signal: new AbortController().signal,
      });
    try {
      const other = await discover(),
        active = await discover(),
        snapshot = { ...active, id: 'active' };
      expect(a.publish(snapshot) && t.activate(active, snapshot, () => a.current(snapshot))).toBe(
        true,
      );
      a.grant(['write']);
      const prep = SessionWriter.prototype.prepare;
      if (mode === 'metadata')
        vi.spyOn(SessionWriter.prototype, 'prepare').mockImplementation(async function (
          this: SessionWriter,
          method,
        ) {
          if (method === 'tools/list') {
            enter.open();
            await resume.wait;
          }
          return prep.call(this, method);
        });
      const drained = latch();
      const admit = SessionWriter.prototype.admit;
      let allowed = false;
      vi.spyOn(SessionWriter.prototype, 'admit').mockImplementation(function (
        this: SessionWriter,
        method,
        send,
      ) {
        if (method !== (mode === 'business' ? 'tools/call' : 'tools/list'))
          return admit.call(this, method, send);
        try {
          admit.call(this, method, send);
          allowed = true;
        } finally {
          drained.open();
        }
      });
      const result =
        mode === 'business'
          ? a.call('active', 'write', { value: 'alpha' }, 'held').then((r) => r.outcome?.kind)
          : discover().then(
              () => 'catalog',
              () => 'refused',
            );
      await enter.wait;
      const before = f.rows.length;
      // Inject losing cleanup evidence only after really closing this separate candidate.
      const close = Client.prototype.close;
      vi.spyOn(Client.prototype, 'close').mockImplementationOnce(async function (this: Client) {
        await close.call(this);
        throw Error('observation lost');
      });
      expect(await t.disposeCandidate(other)).toEqual({ status: 'unknown' });
      expect(a.metadata(c) && a.current(snapshot)).toBe(true);
      resume.open();
      expect(await result).toBe(mode === 'business' ? 'not_started' : 'refused');
      await drained.wait;
      expect(allowed).toBe(false);
      expect(f.rows.slice(before)).toEqual([]);
      expect([f.stats.calls, f.stats.effects]).toEqual([0, 0]);
    } finally {
      resume.open();
      vi.restoreAllMocks();
      await t.close();
      a.store.close();
      await f.close();
      await rm(dir, { recursive: true });
    }
  },
);

it('preserves uncertainty for a call already received when cleanup elsewhere becomes unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-sent-')),
    f = await httpFixture('defer-response');
  let attempts = 0;
  const t = createMcpServiceTransport({
    protocol: '2026-07-28',
    prepareDispatch: () => {
      attempts++;
    },
  });
  const c = connection({ kind: 'http', url: f.url.href }),
    a = admission(join(dir, 'db'), c, t);
  const discover = () =>
    t.discover(c, {
      authorizeMetadata: () => a.metadata(c),
      deadlineMs: 2000,
      signal: new AbortController().signal,
    });
  try {
    const other = await discover(),
      active = await discover(),
      s = { ...active, id: 'active' };
    expect(a.publish(s) && t.activate(active, s, () => a.current(s))).toBe(true);
    a.grant(['write']);
    const call = a.call(s.id, 'write', { value: 'alpha' }, 'sent');
    await vi.waitFor(() => expect(f.stats.effects).toBe(1));
    const close = Client.prototype.close;
    vi.spyOn(Client.prototype, 'close').mockImplementationOnce(async function (this: Client) {
      await close.call(this);
      throw Error('observation lost');
    });
    expect(await t.disposeCandidate(other)).toEqual({ status: 'unknown' });
    expect((await call).outcome?.kind).toBe('uncertain');
    expect([attempts, f.stats.calls, f.stats.effects]).toEqual([1, 1, 1]);
  } finally {
    f.releaseResponse();
    vi.restoreAllMocks();
    await t.close();
    a.store.close();
    await f.close();
    await rm(dir, { recursive: true });
  }
});
