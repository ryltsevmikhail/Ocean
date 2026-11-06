import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ServiceTurnTools } from '@runnets/application';
import type { ChatTurn, ServiceConnection } from '@runnets/domain';
import { createMcpServiceTransport } from './index.js';
import { httpFixture } from './prototype-http-fixture.js';
import { admission, connection, subject } from '../test-fixtures/admission.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const turn = {
  ...subject,
  id: 'turn',
  taskRunId: 'run',
  status: 'accepted',
  bot: { id: 'bot' },
} as unknown as ChatTurn;
const signal = () => new AbortController().signal;

it('projects accepted SQLite grants before dispatch and binds exact call identities through the SDK', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neutral-turn-'));
  const f = await httpFixture('normal');
  const t = createMcpServiceTransport({ protocol: '2026-07-28' });
  const c = connection({ kind: 'http', url: f.url.href });
  const a = admission(join(dir, 'db'), c, t);
  try {
    const candidate = await t.discover(c, {
      signal: signal(),
      deadlineMs: 2000,
      authorizeMetadata: () => a.metadata(c),
    });
    const snapshot = { ...candidate, id: 'first' };
    expect(a.publish(snapshot) && t.activate(candidate, snapshot, () => a.current(snapshot))).toBe(
      true,
    );
    a.grant(['write']);
    const source = new ServiceTurnTools({
      store: a.authority,
      admission: { call: a.service.call.bind(a.service) },
      ownerId: 'owner',
      now: Date.now,
      restored: false,
      sha256: hash,
      subject: () => subject,
      ready: (c, s) => t.ready(c, s),
    });
    const db = new DatabaseSync(join(dir, 'db'));
    db.exec(
      "UPDATE ocean_chat_turns SET status='accepted',payload=json_set(payload,'$.status','accepted')",
    );
    const tools = await source.forTurn(turn, signal());
    expect(tools?.definitions[0]?.name).toBe(
      'mcp_' + hash(JSON.stringify([c.id, 'write'])).slice(0, 56),
    );
    expect(await a.store.tools.pending()).toEqual([]);
    db.exec(
      "UPDATE ocean_chat_turns SET status='dispatching',payload=json_set(payload,'$.status','dispatching')",
    );
    db.close();
    const call = {
      id: 'provider-call',
      name: tools!.definitions[0]!.name,
      arguments: '{"value":"alpha"}',
    };
    const context = { taskRunId: 'run', attemptId: 'attempt' };
    const result = await tools!.execute(call, signal(), context);
    expect(result.isError).toBe(false);
    expect(await tools!.execute(call, signal(), context)).toEqual(result);
    expect(
      (await tools!.execute({ ...call, arguments: '{"value":"beta"}' }, signal(), context)).isError,
    ).toBe(true);
    expect(
      (await tools!.execute({ ...call, id: 'forged', name: 'write' }, signal(), context)).isError,
    ).toBe(true);
    expect([f.stats.calls, f.stats.effects]).toEqual([1, 1]);
    a.owner.revoke({ grantId: 'grant', revision: 1 });
    expect(await source.forTurn(turn, signal())).toBeNull();
    expect((await tools!.execute({ ...call, id: 'revoked' }, signal(), context)).isError).toBe(
      true,
    );
    expect(f.stats.calls).toBe(1);
  } finally {
    await t.close();
    a.store.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  'absent',
  'expired',
  'foreign',
  'restored',
  'review',
  'unavailable',
  'changed',
  'confirm',
])('keeps normal tool authority closed for %s with zero business sends', async (mode) => {
  const dir = await mkdtemp(join(tmpdir(), 'neutral-denial-'));
  const f = await httpFixture('normal');
  const t = createMcpServiceTransport({ protocol: '2026-07-28' });
  const c = connection({ kind: 'http', url: f.url.href });
  const a = admission(join(dir, 'db'), c, t);
  try {
    const candidate = await t.discover(c, {
      signal: signal(),
      deadlineMs: 2000,
      authorizeMetadata: () => a.metadata(c),
    });
    const snapshot = { ...candidate, id: 'first' };
    expect(a.publish(snapshot) && t.activate(candidate, snapshot, () => a.current(snapshot))).toBe(
      true,
    );
    if (mode !== 'absent') a.grant(['write']);
    if (mode === 'expired' || mode === 'confirm')
      a.authority.atomic((tx) => {
        const g = tx.grant('grant')!;
        tx.putGrant(
          {
            ...g,
            revision: 2,
            ...(mode === 'expired'
              ? { limits: { ...g.limits, expiresAt: new Date(Date.now() - 1000).toISOString() } }
              : { mode: 'confirm' }),
          },
          1,
        );
      });
    if (mode === 'changed')
      a.authority.atomic((tx) => {
        const changed = {
          ...snapshot,
          id: 'changed',
          tools: snapshot.tools.map((tool) => ({ ...tool, description: 'changed' })),
        };
        tx.putCatalog(changed);
        tx.publishCatalog(c.id, c, changed.id);
      });
    if (mode === 'unavailable') await t.close();
    const source = new ServiceTurnTools({
      store: a.authority,
      admission: a.service,
      ownerId: 'owner',
      now: Date.now,
      restored: mode === 'restored',
      sha256: hash,
      subject: () => (mode === 'foreign' ? { ...subject, roomId: 'other' } : subject),
      ready: (c, s) => t.ready(c, s),
    });
    const tools = await source.forTurn(
      mode === 'review' ? { ...turn, continuationReviewId: 'review' } : turn,
      signal(),
    );
    if (mode === 'confirm') {
      expect(tools).not.toBeNull();
      expect(
        (
          await tools!.execute(
            { id: 'confirm', name: tools!.definitions[0]!.name, arguments: '{}' },
            signal(),
            { taskRunId: 'run', attemptId: 'at' },
          )
        ).output,
      ).toContain('confirmation_required');
    } else expect(tools).toBeNull();
    expect([f.stats.calls, f.stats.effects]).toEqual([0, 0]);
  } finally {
    await t.close();
    a.store.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('separates identical raw names by connection and explicitly refuses alias collisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neutral-alias-'));
  const f = await httpFixture('normal');
  const t = createMcpServiceTransport({ protocol: '2026-07-28' });
  const c = connection({ kind: 'http', url: f.url.href });
  const a = admission(join(dir, 'db'), c, t);
  try {
    for (const target of [c, { ...c, id: 'second' }]) {
      if (target.id !== c.id) a.authority.atomic((tx) => tx.putConnection(target, null));
      const candidate = await t.discover(target, {
        signal: signal(),
        deadlineMs: 2000,
        authorizeMetadata: () => true,
      });
      const snapshot = { ...candidate, id: target.id + '_catalog' };
      a.publish(snapshot);
      expect(t.activate(candidate, snapshot, () => true)).toBe(true);
      a.owner.issue({
        id: target.id + '_grant',
        subject,
        permissions: [
          {
            kind: 'service',
            connectionId: target.id,
            trustRevision: 1,
            tools: { kind: 'exact', names: ['write'] },
            resources: [{ kind: 'connection', connectionId: target.id }],
          },
        ],
        limits: { maxCalls: 16, maxEffectBytes: 65536, expiresAt: null },
      });
    }
    const options = {
      store: a.authority,
      admission: a.service,
      ownerId: 'owner',
      now: Date.now,
      restored: false,
      sha256: hash,
      subject: () => subject,
      ready: (c: ServiceConnection, s: Parameters<typeof t.ready>[1]) => t.ready(c, s),
    };
    const tools = await new ServiceTurnTools(options).forTurn(turn, signal());
    expect(new Set(tools!.definitions.map((d) => d.name)).size).toBe(2);
    await expect(
      new ServiceTurnTools({ ...options, sha256: () => 'a'.repeat(64) }).forTurn(turn, signal()),
    ).rejects.toThrow('service_name_collision');
    expect(f.stats.calls).toBe(0);
  } finally {
    await t.close();
    a.store.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
