import { afterEach, describe, expect, it } from 'vitest';
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
