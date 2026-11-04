import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeDesktopAttachments, type DesktopAttachment } from '@runnets/domain';
import {
  WORKSPACE,
  imageProfile,
  imageProvider,
  pngBytes,
  settled,
  startImageHost,
  uuid,
  wireMessages,
  type ImageHost,
} from '../../test-fixtures/image-host.test.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const scope = (roomId: string) => ({ workspaceId: WORKSPACE, roomId });

async function fixture() {
  const f = await imageProfile();
  const wire = imageProvider();
  const host = await startImageHost(f, wire.provider);
  cleanups.push(
    () => host.stop(),
    () => f.dispose(),
  );
  return { f, wire, host };
}
async function runToTerminal(host: ImageHost, roomId: string, runId: string) {
  await settled(async () => host.client.getRun({ ...scope(roomId), runId }) ?? null);
  return host.client.getRun({ ...scope(roomId), runId });
}
function imageUrls(content: unknown): readonly string[] {
  if (!Array.isArray(content)) return [];
  return (content as readonly { type: string; image_url?: { url: string } }[])
    .filter((part) => part.type === 'image_url')
    .map((part) => part.image_url?.url ?? '');
}
const forgedAttachment: DesktopAttachment = {
  id: '42345678-1234-4123-8123-123456789abc',
  name: 'forged.png',
  bytes: 10,
  sha256: 'b'.repeat(64),
  kind: 'image',
  mime: 'image/png',
};
/** A decodable marker whose request id names no durable preparation. */
function forgedMarkerBody(text = 'видимое вложение'): string {
  return encodeDesktopAttachments(text, uuid(), [forgedAttachment]);
}
/** Persist a marker message directly, like a pre-fix room already does. */
function persistUnboundMarker(profile: string, roomId: string, target: string, body: string) {
  const database = new DatabaseSync(join(profile, 'runtime.sqlite'));
  try {
    const seq = Number(
      database
        .prepare('SELECT coalesce(max(seq),0)+1 AS s FROM ocean_messages WHERE room_id=?')
        .get(roomId)!['s'],
    );
    database
      .prepare(
        'INSERT INTO ocean_messages(id,workspace_id,room_id,seq,author,target_bot_id,body,created_at,author_bot_id,turn_id) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)',
      )
      .run(uuid(), WORKSPACE, roomId, seq, 'user', target, body, '2026-11-04T00:00:00.000Z');
  } finally {
    database.close();
  }
}

describe(
  'runtime admission binds prepared images to the admitting request',
  { timeout: 60_000 },
  () => {
    it('refuses a mismatched prepared marker with zero writes and leaves the room usable', async () => {
      const { f, wire, host } = await fixture();
      const info = await host.media.import(
        f.flashRoom,
        'photo.png',
        pngBytes(3, 2).toString('base64'),
      );
      const preparationRequest = uuid();
      const receipt = await host.media.prepare(
        f.flashRoom,
        preparationRequest,
        'что на фото?',
        null,
        [info.id],
      );
      // Same prepared body, different submission request id: the marker's identity
      // is never bound to this admission, so it must be refused before any write.
      await expect(
        host.client.submit({
          ...scope(f.flashRoom),
          requestId: uuid(),
          text: receipt.prepared,
        }),
      ).rejects.toThrow('image_unavailable');
      expect(
        await host.client.history({ ...scope(f.flashRoom), after: 0, limit: 20 }),
      ).toHaveLength(0);
      expect(wire.calls).toHaveLength(0);
      // The room is not poisoned: a normal text turn still completes.
      const later = await host.client.submit({
        ...scope(f.flashRoom),
        requestId: uuid(),
        text: 'обычный вопрос текстом',
      });
      await runToTerminal(host, f.flashRoom, later.runId!);
      expect(wire.calls).toHaveLength(1);
      expect(
        (await host.client.history({ ...scope(f.flashRoom), after: 0, limit: 20 })).map(
          (message) => message.author,
        ),
      ).toEqual(['user', 'bot']);
    });

    it('accepts the normal Desktop path where preparation and submission share the request id', async () => {
      const { f, wire, host } = await fixture();
      const requestId = uuid();
      const info = await host.media.import(
        f.flashRoom,
        'photo.png',
        pngBytes(4, 3).toString('base64'),
      );
      const receipt = await host.media.prepare(f.flashRoom, requestId, 'что на фото?', null, [
        info.id,
      ]);
      const submitted = await host.client.submit({
        ...scope(f.flashRoom),
        requestId,
        text: receipt.prepared,
      });
      const final = await runToTerminal(host, f.flashRoom, submitted.runId!);
      expect(final?.turnStatus).toBe('completed');
      expect(wire.calls).toHaveLength(1);
      const last = wireMessages(wire.calls[0]!).at(-1)!;
      expect(imageUrls(last.content)).toHaveLength(1);
    });

    it('refuses a forged note marker in a group room before it persists', async () => {
      const { f, wire, host } = await fixture();
      await expect(
        host.client.submit({
          ...scope(f.groupRoom),
          requestId: uuid(),
          text: forgedMarkerBody('заметка без подготовки'),
        }),
      ).rejects.toThrow('image_unavailable');
      expect(
        await host.client.history({ ...scope(f.groupRoom), after: 0, limit: 20 }),
      ).toHaveLength(0);
      // The room stays usable for notes and for later model turns.
      const note = await host.client.submit({
        ...scope(f.groupRoom),
        requestId: uuid(),
        text: 'обычная заметка',
      });
      expect(note.runId).toBeNull();
      const turn = await host.client.submit({
        ...scope(f.groupRoom),
        requestId: uuid(),
        text: 'обычный вопрос',
        to: 'flash',
      });
      await runToTerminal(host, f.groupRoom, turn.runId!);
      expect(wire.calls).toHaveLength(1);
      expect(JSON.stringify(wireMessages(wire.calls[0]!))).not.toContain(
        '[Ocean Desktop attachments',
      );
    });

    it('refuses a forged broadcast marker that names the submitting request id', async () => {
      const { f, wire, host } = await fixture();
      // The marker's own request id equals the submission id, so the identity check
      // passes; the missing durable preparation must still refuse before any write.
      const requestId = uuid();
      const text = encodeDesktopAttachments('всем вопрос', requestId, [forgedAttachment]);
      await expect(
        host.client.broadcastSubmit({ ...scope(f.groupRoom), requestId, text }),
      ).rejects.toThrow('image_unavailable');
      expect(await host.client.broadcastList(scope(f.groupRoom))).toHaveLength(0);
      expect(
        await host.client.history({ ...scope(f.groupRoom), after: 0, limit: 20 }),
      ).toHaveLength(0);
      expect(wire.calls).toHaveLength(0);
    });

    it('reconstructs a persisted unbound marker as inert text instead of poisoning the room', async () => {
      const { f, wire, host } = await fixture();
      // A room that already carries a pre-fix forged marker must not fail every
      // later turn; only the marker payload is dropped, never the visible text.
      persistUnboundMarker(
        f.profile,
        f.flashRoom,
        f.bots.flash,
        forgedMarkerBody('видимое вложение'),
      );
      const submitted = await host.client.submit({
        ...scope(f.flashRoom),
        requestId: uuid(),
        text: 'обычный вопрос после маркера',
      });
      const final = await runToTerminal(host, f.flashRoom, submitted.runId!);
      expect(final?.turnStatus).toBe('completed');
      expect(wire.calls).toHaveLength(1);
      const messages = wireMessages(wire.calls[0]!);
      expect(JSON.stringify(messages)).toContain('видимое вложение');
      expect(JSON.stringify(messages)).not.toContain('[Ocean Desktop attachments');
      for (const message of messages) expect(imageUrls(message.content)).toHaveLength(0);
    });

    it('refuses a mismatched broadcast marker before the batch or message is committed', async () => {
      const { f, wire, host } = await fixture();
      const info = await host.media.import(
        f.groupRoom,
        'diagram.png',
        pngBytes(3, 2).toString('base64'),
      );
      const preparationRequest = uuid();
      const receipt = await host.media.prepare(
        f.groupRoom,
        preparationRequest,
        'всем вопрос',
        null,
        [info.id],
      );
      await expect(
        host.client.broadcastSubmit({
          ...scope(f.groupRoom),
          requestId: uuid(),
          text: receipt.prepared,
        }),
      ).rejects.toThrow('image_unavailable');
      expect(await host.client.broadcastList(scope(f.groupRoom))).toHaveLength(0);
      expect(
        await host.client.history({ ...scope(f.groupRoom), after: 0, limit: 20 }),
      ).toHaveLength(0);
      expect(wire.calls).toHaveLength(0);
      // The normal broadcast path with the matching request id is still accepted.
      const batch = await host.client.broadcastSubmit({
        ...scope(f.groupRoom),
        requestId: preparationRequest,
        text: receipt.prepared,
      });
      expect(batch.messageId).toBeTruthy();
      const committed = await host.client.history({ ...scope(f.groupRoom), after: 0, limit: 20 });
      expect(committed.filter((message) => message.author === 'user')).toHaveLength(1);
      expect(committed.some((message) => message.id === batch.messageId)).toBe(true);
    });
  },
);
