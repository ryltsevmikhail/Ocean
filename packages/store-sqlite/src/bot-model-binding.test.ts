import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BotModelBindingService, ConversationService } from '@runnets/application';
import type { Bot, ChatTurn } from '@runnets/domain';
import {
  bindingFixture,
  createBinding,
} from '../../application/test-fixtures/bot-model-binding.js';
import { openSqliteStore } from './index.js';

const rebind = {
  workspaceId: 'w',
  requestId: 'set',
  botId: 'bot_1',
  expectedProfileVersion: 1,
  binding: { connectionId: 'shared', modelId: 'two' },
};
function fileFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-bind-'));
  const path = join(dir, 'runtime.sqlite');
  const db = openSqliteStore({ path });
  const raw = new DatabaseSync(path);
  return { dir, path, db, raw };
}

describe('SQLite atomic bot bindings', () => {
  it('preserves old receipt, room, turn and history JSON across rebind and reopen', () => {
    const { dir, path, db, raw } = fileFixture();
    let reopened: ReturnType<typeof openSqliteStore> | undefined;
    try {
      const f = bindingFixture(db.conversations, db.modelConnections);
      const legacy = {
        type: 'CreateBot',
        workspaceId: 'w',
        requestId: 'legacy',
        handle: 'old',
        name: 'Old',
        role: 'Freeform',
        provider: 'deepseek',
        model: 'explicit-old',
      } as const;
      const oldReceipt = f.old.execute(legacy);
      const bot = db.conversations.atomic((tx) => tx.bot('bot_1'));
      if (!bot) throw Error('missing bot');
      const roomCommand = {
        type: 'OpenDirectRoom',
        workspaceId: 'w',
        requestId: 'room',
        botId: bot.id,
      } as const;
      const roomReceipt = f.old.execute(roomCommand);
      const messageCommand = {
        type: 'RecordUserMessage',
        workspaceId: 'w',
        requestId: 'message',
        roomId: 'bot_2',
        text: 'Private fixture only',
      } as const;
      const messageReceipt = f.old.execute(messageCommand);
      const turn: ChatTurn = {
        id: 'turn',
        workspaceId: 'w',
        roomId: 'bot_2',
        requestId: 'turn-request',
        taskRunId: 'run',
        inboundMessageId: 'bot_3',
        readThroughSeq: 1,
        bot,
        status: 'completed',
        text: 'Historical reply',
        preparedVersion: 1,
        stopReason: 'end_turn',
      };
      db.conversations.atomic((tx) => tx.putChatTurn(turn));
      const before = snapshot(raw);
      const changed = f.service.set(rebind);
      expect(changed).toMatchObject({
        ok: true,
        value: { bot: { model: 'two', profileVersion: 2 } },
      });
      expect(snapshot(raw)).toEqual(before);
      expect(f.old.execute(legacy)).toEqual(oldReceipt);
      const created = f.service.create({ ...createBinding, handle: 'new', requestId: 'new' });
      const row = raw.prepare("SELECT reply FROM ocean_receipts WHERE request_id='new'").get();
      expect(JSON.parse(String(row?.['reply']))).toEqual({
        kind: 'bound_bot',
        data: created.ok ? created.value : null,
      });
      db.close();
      reopened = openSqliteStore({ path });
      const service = new BotModelBindingService({
        store: reopened.conversations,
        connections: {
          read: () => {
            throw Error('no current lookup on replay');
          },
        },
        factory: {
          catalog: () => {
            throw Error('no current catalog on replay');
          },
        },
        nextId: () => {
          throw Error('no identity on replay');
        },
      });
      expect(service.set(rebind)).toEqual(changed);
      expect(service.create({ ...createBinding, handle: 'new', requestId: 'new' })).toEqual(
        created,
      );
      const old = new ConversationService({
        store: reopened.conversations,
        nextId: () => 'unused',
        clock: { now: () => new Date(0) },
      });
      expect(old.execute(legacy)).toEqual(oldReceipt);
      expect(old.execute(roomCommand)).toEqual(roomReceipt);
      expect(old.execute(messageCommand)).toEqual(messageReceipt);
      expect(reopened.conversations.atomic((tx) => tx.chatTurn('turn'))).toEqual(turn);
      expect(reopened.conversations.atomic((tx) => tx.modelBinding(bot.id))).toEqual(
        rebind.binding,
      );
      expect(snapshot(raw)).toEqual(before);
    } finally {
      reopened?.close();
      db.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back bot, binding and receipt after a real SQL receipt failure and remains rolled back on reopen', () => {
    const { dir, path, db, raw } = fileFixture();
    let reopened: ReturnType<typeof openSqliteStore> | undefined;
    try {
      const f = bindingFixture(db.conversations, db.modelConnections);
      f.service.create(createBinding);
      const before = db.conversations.atomic((tx) => [tx.bots(), tx.modelBinding('bot_1')]);
      raw.exec(`CREATE TRIGGER reject_binding_receipt BEFORE INSERT ON ocean_receipts
        BEGIN SELECT RAISE(ABORT,'receipt rejected'); END`);
      expect(() => f.service.set(rebind)).toThrow('receipt rejected');
      expect(() => f.service.create({ ...createBinding, requestId: 'new', handle: 'new' })).toThrow(
        'receipt rejected',
      );
      expect(db.conversations.atomic((tx) => [tx.bots(), tx.modelBinding('bot_1')])).toEqual(
        before,
      );
      db.close();
      reopened = openSqliteStore({ path });
      expect(reopened.conversations.atomic((tx) => [tx.bots(), tx.modelBinding('bot_1')])).toEqual(
        before,
      );
      expect(
        reopened.conversations.atomic((tx) => [
          tx.receipt('set'),
          tx.receipt('new'),
          tx.modelBinding('bot_2'),
        ]),
      ).toEqual([null, null, null]);
    } finally {
      reopened?.close();
      db.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces insertion-only putBot and transactional replacement CAS without leaking binding writes', () => {
    const { dir, db, raw } = fileFixture();
    try {
      const f = bindingFixture(db.conversations, db.modelConnections);
      f.service.create(createBinding);
      const bot = db.conversations.atomic((tx) => tx.bot('bot_1'));
      if (!bot) throw Error('missing bot');
      expect(() => db.conversations.atomic((tx) => tx.putBot(bot))).toThrow();
      const next: Bot = { ...bot, profileVersion: 2, model: 'two' };
      expect(() =>
        db.conversations.atomic((tx) => {
          tx.putModelBinding(bot.id, rebind.binding);
          tx.replaceBot(next, 2);
        }),
      ).toThrow('bot_profile_version_conflict');
      expect(db.conversations.atomic((tx) => tx.bot(bot.id))).toEqual(bot);
      expect(db.conversations.atomic((tx) => tx.modelBinding(bot.id))).toEqual(
        createBinding.binding,
      );
      db.conversations.atomic((tx) => tx.replaceBot(next, 1));
      expect(db.conversations.atomic((tx) => tx.bot(bot.id))).toEqual(next);
    } finally {
      db.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects array receipt discriminators instead of coercing them into a new or legacy kind', () => {
    const { dir, db, raw } = fileFixture();
    try {
      const f = bindingFixture(db.conversations, db.modelConnections);
      f.service.create(createBinding);
      for (const kind of [['bound_bot'], ['bot']]) {
        raw
          .prepare("UPDATE ocean_receipts SET reply=? WHERE request_id='create'")
          .run(JSON.stringify({ kind, data: {} }));
        expect(() => db.conversations.atomic((tx) => tx.receipt('create'))).toThrow(
          'Invalid conversation receipt',
        );
      }
    } finally {
      db.close();
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
function snapshot(db: DatabaseSync) {
  return {
    receipts: db
      .prepare(
        "SELECT * FROM ocean_receipts WHERE request_id IN ('legacy','room','message') ORDER BY request_id",
      )
      .all(),
    rooms: db.prepare('SELECT * FROM ocean_rooms').all(),
    messages: db.prepare('SELECT * FROM ocean_messages').all(),
    turns: db.prepare('SELECT * FROM ocean_chat_turns').all(),
  };
}
