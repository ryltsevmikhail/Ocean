import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ChatReviewService,
  ConversationService,
  DirectChatService,
  TaskRunService,
  type ModelActivationSnapshot,
} from '@runnets/application';
import { SequentialIdGenerator } from '@runnets/store';
import { openSqliteStore } from '@runnets/store-sqlite';
import { createLocalProvider } from '@runnets/provider-local';
import { endpoint, fixture, qualification } from './local-model.js';

export function preflightFixture() {
  const root = mkdtempSync(join(tmpdir(), 'oa-preflight-'));
  const path = join(root, 'runtime.sqlite');
  const store = openSqliteStore({ path });
  const legacyClaim = () => {
    const db = new DatabaseSync(path);
    try {
      db.exec("INSERT INTO tool_invocations_v1 VALUES ('legacy','plugin','uncertain')");
    } finally {
      db.close();
    }
  };
  const close = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };
  const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };
  const nextId = () => randomUUID().replaceAll('-', '');
  const tasks = new TaskRunService({ log: store.log, ids: new SequentialIdGenerator(), clock });
  const deps = { store: store.conversations, tasks, clock, nextId };
  const reviews = new ChatReviewService({ ...deps, journal: store.tools });
  const conversations = new ConversationService(deps);
  conversations.execute({
    type: 'BindWorkspace',
    workspaceId: 'work',
    requestId: 'init',
    root: '/fixture',
  });
  const bot = conversations.execute({
    type: 'CreateBot',
    workspaceId: 'work',
    requestId: 'bot',
    handle: 'local',
    name: 'Local',
    role: 'fixture',
    provider: 'ollama',
    model: 'qwen3:1.7b',
  });
  if (!bot.ok || bot.value.kind !== 'bot') throw Error('fixture bot');
  const room = conversations.execute({
    type: 'OpenDirectRoom',
    workspaceId: 'work',
    requestId: 'room',
    botId: bot.value.data.id,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('fixture room');
  const http = fixture({ '/api/version': { version: 'drift' } });
  const provider = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: http.http,
  });
  const snapshot: ModelActivationSnapshot = {
    version: 1,
    identity: {
      source: 'connection',
      connectionId: 'legacy:ollama',
      providerId: 'ollama',
      modelId: 'qwen3:1.7b',
      connectionRevision: 2,
      botProfileVersion: 1,
      kind: 'local',
      endpoint,
      auth: 'none',
      artifactDigest: qualification.artifactDigest,
      backendVersion: qualification.backendVersion,
    },
    capabilities: qualification.capabilities,
    limits: { maxModelRequests: 24, requestTimeoutMs: 120000, turnTimeoutMs: 600000 },
    admittedAt: clock.now().toISOString(),
    deadlineAt: '2026-11-04T00:10:00.000Z',
  };
  const resolver = { resolve: () => ({ ok: true as const, value: { provider, snapshot } }) };
  const chat = new DirectChatService({ ...deps, reviews });
  const input = {
    workspaceId: 'work',
    roomId: room.value.data.id,
    requestId: 'first',
    text: 'hello',
    resolver,
    signal: new AbortController().signal,
    emit: () => {},
  };
  return { ...deps, close, legacyClaim, store, reviews, chat, input, http, conversations };
}
