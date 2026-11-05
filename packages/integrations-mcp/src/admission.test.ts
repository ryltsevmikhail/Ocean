import { it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServiceTransport } from './index.js';
import { httpFixture, definition } from './prototype-http-fixture.js';
import { admission, connection } from '../test-fixtures/admission.js';

it.each(['revoke', 'cancel', 'deadline', 'drop', 'invalid', 'growth', 'rotation'])(
  'checks current SQLite authority at the actual SDK writer: %s',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-admission-'));
    const f = await httpFixture(mode, dir);
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    };
    const entered = gate(),
      release = gate();
    let attempts = 0,
      refresh = 0;
    const t = createMcpServiceTransport({
      protocol: '2026-07-28',
      resolveCredential: (_ref, c) => 'synthetic-' + c.credentialRevision,
      prepareDispatch: async () => {
        attempts++;
        entered.resolve();
        await release.promise;
      },
      refreshNeeded: () => {
        refresh++;
      },
    });
    const c = connection({ kind: 'http', url: f.url.href }, 'env:SYNTHETIC');
    const a = admission(join(dir, 'db'), c, t, mode === 'deadline' ? 150 : 3000);
    const discover = (target: typeof c) =>
      t.discover(target, {
        authorizeMetadata: () => a.metadata(target),
        signal: new AbortController().signal,
        deadlineMs: 2000,
      });
    try {
      const first = await discover(c),
        s = { ...first, id: 'first' };
      expect(a.publish(s) && t.activate(first, s, () => a.current(s))).toBe(true);
      a.grant(['write']);
      const ac = new AbortController();
      const call = a.call(s.id, 'write', { value: 'alpha' }, 'i', ac.signal);
      await entered.promise;
      if (mode === 'revoke') a.owner.revoke({ grantId: 'grant', revision: 1 });
      if (mode === 'cancel') ac.abort();
      if (mode === 'growth' || mode === 'rotation') {
        const old = await discover(c);
        f.extra.push({ ...definition('extra'), name: 'extra' });
        const target = a.authority.atomic((tx) => {
          const current = tx.connection(c.id)!;
          if (mode === 'growth') return current;
          const next = { ...current, credentialRevision: 2 };
          expect(tx.putConnection(next, current)).toBe(true);
          return next;
        });
        const fresh = await discover(target),
          s2 = { ...fresh, id: 'second' };
        expect(fresh.tools).toHaveLength(2);
        expect(a.publish(s2) && t.activate(fresh, s2, () => a.current(s2))).toBe(true);
        expect(t.activate(old, { ...old, id: s.id }, () => a.current(s))).toBe(false);
        await t.disposeCandidate(old);
      }
      if (mode !== 'deadline') release.resolve();
      const result = await call;
      release.resolve();
      await delay(15);
      const yes = ['growth', 'drop', 'invalid'].includes(mode);
      expect(result.outcome?.kind).toBe(
        yes ? (mode === 'growth' ? 'observed' : 'uncertain') : 'not_started',
      );
      expect([attempts, f.stats.calls, f.stats.effects]).toEqual([1, Number(yes), Number(yes)]);
      expect((await a.call(s.id, 'write', { value: 'alpha' }, 'i')).outcome).toBeNull();
      for (const [file, line] of [
        ['dispatches', 'send'],
        ['effects', 'effect'],
      ])
        expect(await readFile(join(dir, file!), 'utf8').catch(() => '')).toBe(
          yes ? line + '\n' : '',
        );
      if (yes) {
        const pairs = f.pairs[0]!;
        expect(pairs).toEqual(['Authorization', 'Bearer synthetic-1', 'Mcp-Param-alpha', 'alpha']);
      }
      if (mode === 'growth') {
        const n = f.rows.length;
        await delay(1100);
        expect(refresh).toBe(1);
        expect(f.rows).toHaveLength(n);
      }
    } finally {
      release.resolve();
      await t.close();
      a.store.close();
      await f.close();
      await rm(dir, { recursive: true });
    }
  },
);
