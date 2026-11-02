import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService, type ConversationStore } from '@runnets/application';
import { InMemoryConversationStore } from '@runnets/store';
import { openSqliteStore } from './index.js';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function service(store: ConversationStore): ConversationService {
  let id = 0;
  return new ConversationService({
    store,
    nextId: () => 'id_' + String(++id),
    clock: { now: () => new Date('2026-11-02T00:00:00.000Z') },
  });
}
const bind = {
  type: 'BindWorkspace',
  requestId: 'init',
  workspaceId: 'w',
  root: '/project',
} as const;
const bot = {
  type: 'CreateBot',
  requestId: 'dev',
  workspaceId: 'w',
  handle: 'dev',
  name: 'Разработчик',
  role: 'Правит код',
  provider: 'deepseek',
  model: 'test-model',
} as const;
const open = {
  type: 'OpenDirectRoom',
  requestId: 'open',
  workspaceId: 'w',
  botId: 'id_1',
} as const;

for (const adapter of ['memory', 'sqlite'] as const) {
  describe(adapter + ' M1 contract', () => {
    function setup(): ConversationService {
      if (adapter === 'memory') return service(new InMemoryConversationStore());
      const db = openSqliteStore({ path: ':memory:' });
      closers.push(() => db.close());
      return service(db.conversations);
    }
    it('keeps bot identity, one direct room and isolated ordered histories', () => {
      const s = setup();
      expect(s.execute(bind).ok).toBe(true);
      expect(s.execute(bot)).toMatchObject({
        ok: true,
        value: { kind: 'bot', data: { id: 'id_1', handle: 'dev', profileVersion: 1 } },
      });
      expect(s.execute(open)).toMatchObject({
        ok: true,
        value: { kind: 'room', data: { id: 'id_2' } },
      });
      expect(s.execute({ ...open, requestId: 'again' })).toEqual(s.execute(open));
      expect(s.execute({ ...bot, requestId: 'review', handle: 'review' })).toMatchObject({
        ok: true,
        value: { data: { id: 'id_3' } },
      });
      s.execute({ ...open, requestId: 'other-room', botId: 'id_3' });
      const record = {
        type: 'RecordUserMessage',
        requestId: 'msg',
        workspaceId: 'w',
        roomId: 'id_2',
        text: 'Привет',
      } as const;
      expect(s.execute(record)).toMatchObject({
        ok: true,
        value: { kind: 'message', data: { seq: 1, body: 'Привет' } },
      });
      expect(s.execute(record)).toEqual(s.execute(record));
      s.execute({ ...record, requestId: 'msg2', text: 'Уточнение' });
      expect(s.history('w', 'id_2')).toMatchObject({ ok: true, value: [{ seq: 1 }, { seq: 2 }] });
      expect(s.history('w', 'id_2', 1, 1)).toMatchObject({ ok: true, value: [{ seq: 2 }] });
      expect(s.history('w', 'id_4')).toEqual({ ok: true, value: [] });
      expect(s.bots('w')).toMatchObject({
        ok: true,
        value: [{ handle: 'dev' }, { handle: 'review' }],
      });
    });
    it('rejects conflicting retries, duplicate handles, invalid inputs and foreign scope without writes', () => {
      const s = setup();
      s.execute(bind);
      s.execute(bot);
      s.execute(open);
      expect(s.execute({ ...bot, name: 'Changed' })).toMatchObject({
        ok: false,
        error: { code: 'request_conflict' },
      });
      expect(s.execute({ ...bot, requestId: 'duplicate' })).toMatchObject({
        ok: false,
        error: { code: 'handle_taken' },
      });
      expect(s.execute({ ...bot, requestId: 'bad', handle: '@bad' })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
      expect(s.execute({ ...bot, requestId: 'bad', handle: 'valid' }).ok).toBe(true);
      expect(s.execute({ ...open, requestId: 'unknown', botId: 'missing' })).toMatchObject({
        ok: false,
        error: { code: 'unknown_bot' },
      });
      expect(s.execute({ ...bind, requestId: 'rebind', root: '/elsewhere' })).toMatchObject({
        ok: false,
        error: { code: 'workspace_conflict' },
      });
      expect(s.execute({ ...open, requestId: 'foreign', workspaceId: 'other' })).toMatchObject({
        ok: false,
        error: { code: 'workspace_conflict' },
      });
      expect(s.history('other', 'id_2')).toMatchObject({
        ok: false,
        error: { code: 'workspace_conflict' },
      });
      for (const text of ['', ' ', 'x'.repeat(16385), '😀'.repeat(4097)]) {
        expect(
          s.execute({
            type: 'RecordUserMessage',
            requestId: 'invalid',
            workspaceId: 'w',
            roomId: 'id_2',
            text,
          }),
        ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      }
      expect(s.history('w', 'id_2')).toEqual({ ok: true, value: [] });
      expect(s.history('w', 'id_2', -1)).toMatchObject({ ok: false });
      expect(s.history('w', 'missing')).toMatchObject({
        ok: false,
        error: { code: 'unknown_room' },
      });
    });
    it('returns detached values so callers cannot change committed state', () => {
      const s = setup();
      s.execute(bind);
      const r = s.execute(bot);
      if (!r.ok || r.value.kind !== 'bot') throw new Error('expected bot');
      Reflect.set(r.value.data, 'name', 'mutated');
      expect(s.execute(bot)).toMatchObject({ ok: true, value: { data: { name: 'Разработчик' } } });
    });
  });
}

it('preserves both direct histories and receipts across a real SQLite restart', () => {
  // Real file is required to establish durability; only this temporary directory is touched.
  const dir = mkdtempSync(join(tmpdir(), 'ocean-m1-'));
  let db = openSqliteStore({ path: join(dir, 'runtime.sqlite') });
  try {
    const s = service(db.conversations);
    s.execute(bind);
    s.execute(bot);
    s.execute(open);
    s.execute({ ...bot, requestId: 'review', handle: 'review' });
    s.execute({ ...open, requestId: 'open-review', botId: 'id_3' });
    const cmd = {
      type: 'RecordUserMessage',
      requestId: 'm',
      workspaceId: 'w',
      roomId: 'id_2',
      text: 'Private dev',
    } as const;
    const receipt = s.execute(cmd);
    s.execute({ ...cmd, requestId: 'm-review', roomId: 'id_4', text: 'Private review' });
    db.close();
    db = openSqliteStore({ path: join(dir, 'runtime.sqlite') });
    const restarted = service(db.conversations);
    expect(restarted.execute(cmd)).toEqual(receipt);
    expect(restarted.execute({ ...open, requestId: 'reopen' })).toEqual(safeRoom());
    expect(restarted.history('w', 'id_2')).toMatchObject({
      value: [{ seq: 1, body: 'Private dev' }],
    });
    expect(restarted.history('w', 'id_4')).toMatchObject({
      value: [{ seq: 1, body: 'Private review' }],
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function safeRoom() {
  return {
    ok: true,
    value: { kind: 'room', data: { id: 'id_2', workspaceId: 'w', kind: 'direct', botId: 'id_1' } },
  };
}
