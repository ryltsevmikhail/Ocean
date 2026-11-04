/* eslint-disable no-restricted-imports -- Test-only real-profile authority fixture. */
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore, type SqliteStore } from '@runnets/store-sqlite';
import { ConversationService, DesktopAssetService } from '@runnets/application';
import type { DesktopAttachment } from '@runnets/domain';
import { desktopAssetFiles } from '../src/desktop-enrollment.js';
import { desktopImageResolver } from '../src/desktop-image-resolver.js';

export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEXAOSuU7d9gAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC';
export const GIF = 'R0lGODlhAwACAPAAACeuYAAAACH5BAAAAAAALAAAAAADAAIAAAIChF8AOw==';
export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const roots: string[] = [];
export function cleanupImageAuthorityRoots(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };

export function imageAuthorityFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-image-authority-'));
  roots.push(root);
  const profile = join(root, 'profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  const profileId = sha(profile);
  const path = join(root, 'runtime.sqlite');
  let store: SqliteStore = openSqliteStore({ path });
  let ids = 0;
  const nextId = () => 'room' + String(++ids).padStart(3, '0');
  const conversations = new ConversationService({ store: store.conversations, clock, nextId });
  const execute = conversations.execute.bind(conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId: 'ws_ocean', root: '/project' });
  const createBot = (handle: string) => {
    const created = execute({
      type: 'CreateBot',
      requestId: 'bot-' + handle,
      workspaceId: 'ws_ocean',
      handle,
      name: handle,
      role: 'fixture',
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('bot');
    return created.value.data.id;
  };
  const openRoom = (handle: string) => {
    const botId = createBot(handle);
    botIds[handle] = botId;
    const room = execute({
      type: 'OpenDirectRoom',
      requestId: 'room-' + handle,
      workspaceId: 'ws_ocean',
      botId,
    });
    if (!room.ok || room.value.kind !== 'room' || room.value.data.kind !== 'direct')
      throw Error('room');
    return room.value.data.id;
  };
  const botIds: Record<string, string> = {};
  const roomId = openRoom('dev');
  const otherRoomId = openRoom('other');
  const files = desktopAssetFiles(profile, profileId);
  const service = new DesktopAssetService(store.desktopAssets, files);
  const userData = join(root, 'userData');
  fs.mkdirSync(userData, { mode: 0o700 });
  service.enroll(userData);
  return {
    root,
    path,
    profile,
    profileId,
    store: () => store,
    close() {
      store.close();
    },
    reopen() {
      store.close();
      store = openSqliteStore({ path });
    },
    files,
    service,
    roomId,
    otherRoomId,
    botId: botIds['dev']!,
    binding: () => store.desktopAssets.binding()!,
    importImage(data = PNG) {
      return files.import(store.desktopAssets.binding()!, roomId, 'photo.png', data);
    },
    prepare(requestId: string, body: string, ids: readonly string[]) {
      return service.prepare(roomId, requestId, body, null, ids);
    },
    insertPreparation(room: string, requestId: string, receipt: unknown) {
      store.close();
      const db = new DatabaseSync(path);
      try {
        db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'completed',?)").run(
          'prepare:' + room + ':' + requestId,
          JSON.stringify({ room, requestId }),
          JSON.stringify(receipt),
        );
      } finally {
        db.close();
      }
      store = openSqliteStore({ path });
    },
    resolver: () => desktopImageResolver(store.desktopAssets, profile, profileId),
  };
}
export type ImageAuthorityFixture = ReturnType<typeof imageAuthorityFixture>;

export function persistPersistedMessage(
  f: ImageAuthorityFixture,
  input: { id: string; body: string; requestId: string; roomId?: string; receipt?: boolean },
) {
  const roomId = input.roomId ?? f.roomId;
  f.store().conversations.atomic((tx) => {
    tx.putMessage({
      id: input.id,
      workspaceId: 'ws_ocean',
      roomId,
      seq: tx.nextSequence(roomId),
      author: 'user',
      targetBotId: f.botId,
      body: input.body,
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    if (input.receipt === false) return;
    const reply = {
      kind: 'message' as const,
      data: {
        id: input.id,
        workspaceId: 'ws_ocean',
        roomId,
        seq: 1,
        author: 'user' as const,
        body: input.body,
        createdAt: '2026-11-04T00:00:00.000Z',
      },
    };
    const binding = ['SendDirect', 'ws_ocean', roomId, input.body];
    tx.putReceipt(input.requestId, { binding: JSON.stringify(binding), reply });
  });
}
export function persistMessage(
  f: ImageAuthorityFixture,
  input: { id: string; body: string; requestId: string; roomId?: string; receipt?: boolean },
) {
  return persistPersistedMessage(f, input);
}
export function expectedFor(info: DesktopAttachment) {
  return [{ id: info.id, sha256: info.sha256 }];
}
export function resolveAuthority(
  f: ImageAuthorityFixture,
  input: {
    messageId: string;
    body: string;
    requestId: string;
    expected: readonly { id: string; sha256: string }[];
    roomId?: string;
    admittedRequestId?: string;
    phase?: 'persisted' | 'committing';
  },
) {
  return f.resolver().resolve({
    workspaceId: 'ws_ocean',
    roomId: input.roomId ?? f.roomId,
    messageId: input.messageId,
    body: input.body,
    requestId: input.requestId,
    expected: input.expected,
    ...(input.admittedRequestId === undefined
      ? {}
      : { admittedRequestId: input.admittedRequestId }),
    phase: input.phase ?? 'persisted',
  });
}

export function craftedPng(width: number, height: number): Buffer {
  const chunk = (type: string, payload: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), payload]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('x'.repeat(64), 'ascii')),
  ]);
}
