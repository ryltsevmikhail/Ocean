import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStore } from './index.js';
import { decodeChatTurn } from './chat-storage.js';
import type { ChatTurn } from '@runnets/domain';

const activation = {
  version: 1 as const,
  identity: { source: 'host' as const, providerId: 'test', modelId: 'test' },
  capabilities: {
    tools: true,
    streaming: true,
    inputModalities: ['text' as const],
    contextTokens: null,
    maxOutputTokens: null,
    usage: 'reported' as const,
  },
  limits: { maxModelRequests: 24, requestTimeoutMs: 120000, turnTimeoutMs: 600000 },
  admittedAt: '2026-11-04T00:00:00.000Z',
  deadlineAt: '2026-11-04T00:10:00.000Z',
};
const turn: ChatTurn = {
  id: 'turn',
  workspaceId: 'workspace',
  roomId: 'room',
  requestId: 'request',
  taskRunId: 'tr_turn',
  inboundMessageId: 'message',
  readThroughSeq: 1,
  bot: {
    id: 'bot',
    workspaceId: 'workspace',
    handle: 'dev',
    name: 'Dev',
    role: 'fixture',
    provider: 'test',
    model: 'test',
    profileVersion: 1,
  },
  status: 'queued',
  text: '',
  preparedVersion: null,
  stopReason: 'end_turn',
};
const row = (value: unknown) => ({ id: 'turn', status: 'queued', payload: JSON.stringify(value) });
it('reads historic absent fields but refuses malformed optional binding/activation authority', () => {
  expect(decodeChatTurn(row(turn))).toEqual(turn);
  for (const field of [
    { activation: null },
    { activation: { ...activation, limits: {} } },
    { modelBinding: null },
    { modelBinding: { connectionId: 'connection', modelId: '' } },
    { modelBinding: { connectionId: 'bad\0id', modelId: 'test' } },
  ])
    expect(() => decodeChatTurn(row({ ...turn, ...field }))).toThrow();
});
it('round-trips both optional fields through a real SQLite close and reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'activation-storage-'));
  const path = join(root, 'fixture.sqlite');
  let db = openSqliteStore({ path });
  try {
    const saved = {
      ...turn,
      activation,
      modelBinding: { connectionId: 'legacy:test', modelId: 'test' },
    };
    db.conversations.atomic((tx) => {
      tx.putWorkspace({ id: 'workspace', root: '/fixture' });
      tx.putBot(turn.bot);
      tx.putRoom({ id: 'room', workspaceId: 'workspace', kind: 'direct', botId: 'bot' });
      tx.putChatTurn(saved);
    });
    db.close();
    db = openSqliteStore({ path });
    expect(db.conversations.atomic((tx) => tx.chatTurn('turn'))).toEqual(saved);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
