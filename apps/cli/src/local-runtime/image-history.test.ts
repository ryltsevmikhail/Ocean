import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  WORKSPACE,
  imageProfile,
  imageProvider,
  pngBytes,
  settled,
  startImageHost,
  uuid,
  wireMessages,
  type ImageProfile,
  type WireProvider,
} from '../../test-fixtures/image-host.test.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function imagesOf(content: unknown): readonly { image_url?: { url: string } }[] {
  if (!Array.isArray(content)) return [];
  return (content as readonly { type: string; image_url?: { url: string } }[]).filter(
    (part) => part.type === 'image_url',
  );
}
async function boot(f: ImageProfile, wire: WireProvider) {
  const host = await startImageHost(f, wire.provider);
  cleanups.push(() => host.stop());
  return host;
}
async function send(
  host: Awaited<ReturnType<typeof startImageHost>>,
  roomId: string,
  text: string,
) {
  const requestId = uuid();
  const submitted = await host.client.submit({ workspaceId: WORKSPACE, roomId, requestId, text });
  const scope = { workspaceId: WORKSPACE, roomId };
  await settled(async () => host.client.getRun({ ...scope, runId: submitted.runId! }) ?? null);
  return { submitted, final: await host.client.getRun({ ...scope, runId: submitted.runId! }) };
}

describe('historical image re-resolution after owner restart', () => {
  it('re-resolves the persisted image for a later turn on a new runtime process', async () => {
    const f = await imageProfile();
    cleanups.push(() => f.dispose());
    const bytes = pngBytes(3, 2);
    const first = imageProvider();
    let host = await boot(f, first);
    const requestId = uuid();
    const info = await host.media.import(f.flashRoom, 'photo.png', bytes.toString('base64'));
    const receipt = await host.media.prepare(f.flashRoom, requestId, 'запомни фото', null, [
      info.id,
    ]);
    const submitted = await host.client.submit({
      workspaceId: WORKSPACE,
      roomId: f.flashRoom,
      requestId,
      text: receipt.prepared,
    });
    await settled(
      async () =>
        host.client.getRun({
          workspaceId: WORKSPACE,
          roomId: f.flashRoom,
          runId: submitted.runId!,
        }) ?? null,
    );
    expect(first.calls).toHaveLength(1);
    await host.stop();
    const second = imageProvider();
    host = await boot(f, second);
    const { final } = await send(host, f.flashRoom, 'что было на фото?');
    expect(final?.turnStatus).toBe('completed');
    expect(second.calls).toHaveLength(1);
    const history = wireMessages(second.calls[0]!);
    const historyWithImage = history.filter(
      (message) => message.role === 'user' && imagesOf(message.content).length > 0,
    );
    expect(historyWithImage).toHaveLength(1);
    const url = imagesOf(historyWithImage[0]!.content)[0]!.image_url!.url;
    expect(sha(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))).toBe(sha(bytes));
    expect(JSON.stringify(history)).not.toContain('[Ocean Desktop attachments');
  });

  it('fails the later turn visibly when historical bytes were replaced after restart', async () => {
    const f = await imageProfile();
    cleanups.push(() => f.dispose());
    const first = imageProvider();
    let host = await boot(f, first);
    const requestId = uuid();
    const info = await host.media.import(
      f.flashRoom,
      'photo.png',
      pngBytes(3, 2).toString('base64'),
    );
    const receipt = await host.media.prepare(f.flashRoom, requestId, 'фото', null, [info.id]);
    const submitted = await host.client.submit({
      workspaceId: WORKSPACE,
      roomId: f.flashRoom,
      requestId,
      text: receipt.prepared,
    });
    await settled(
      async () =>
        host.client.getRun({
          workspaceId: WORKSPACE,
          roomId: f.flashRoom,
          runId: submitted.runId!,
        }) ?? null,
    );
    const database = new DatabaseSync(f.profile + '/runtime.sqlite');
    let root: string;
    try {
      root = String(
        JSON.parse(
          String(
            database.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.[
              'value'
            ],
          ),
        ).root,
      );
    } finally {
      database.close();
    }
    await host.stop();
    writeFileSync(root + '/' + f.flashRoom + '/' + info.id + '/blob', pngBytes(5, 5), {
      mode: 0o600,
    });
    const second = imageProvider();
    host = await boot(f, second);
    await expect(send(host, f.flashRoom, 'а теперь?')).rejects.toThrow('image_unavailable');
    expect(second.calls).toHaveLength(0);
    const history = await host.client.history({
      workspaceId: WORKSPACE,
      roomId: f.flashRoom,
      after: 0,
      limit: 20,
    });
    expect(history.filter((message) => message.author === 'user')).toHaveLength(1);
  });
});

describe('mixed-capability broadcast with images', () => {
  it('gives the image to the capable child and refuses the text-only child before dispatch', async () => {
    const f = await imageProfile();
    cleanups.push(() => f.dispose());
    const wire = imageProvider();
    const host = await boot(f, wire);
    const requestId = uuid();
    const info = await host.media.import(
      f.groupRoom,
      'diagram.png',
      pngBytes(4, 3).toString('base64'),
    );
    const receipt = await host.media.prepare(f.groupRoom, requestId, 'что на диаграмме?', null, [
      info.id,
    ]);
    const batch = await host.client.broadcastSubmit({
      workspaceId: WORKSPACE,
      roomId: f.groupRoom,
      requestId,
      text: receipt.prepared,
    });
    let settledBatch = batch;
    for (let index = 0; index < 400; index++) {
      settledBatch = await host.client.broadcastGet({
        workspaceId: WORKSPACE,
        roomId: f.groupRoom,
        batchId: batch.id,
      });
      if (settledBatch.state !== 'open') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(settledBatch.state).toBe('completed');
    const child = (handle: string) =>
      settledBatch.recipients.find((recipient) => recipient.handle === handle)!;
    expect(child('flash').state).toBe('answered');
    expect(child('pro').state).toBe('refused');
    expect(child('pro').refusalCode).toBe('model_image_unsupported');
    expect(wire.calls).toHaveLength(1);
    const sent = wireMessages(wire.calls[0]!);
    expect(sent.at(-1)!.role).toBe('user');
    const parts = imagesOf(sent.at(-1)!.content);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
    const answer = await host.client.getResult({
      workspaceId: WORKSPACE,
      roomId: f.groupRoom,
      runId: child('flash').runId,
    });
    expect(answer?.body).toBe('Вижу изображение');
  });
});
