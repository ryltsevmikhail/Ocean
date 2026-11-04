import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

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
function texts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as readonly { type: string; text?: string }[])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}
function imagesOf(content: unknown): readonly { image_url?: { url: string } }[] {
  if (!Array.isArray(content)) return [];
  return (content as readonly { type: string; image_url?: { url: string } }[]).filter(
    (part) => part.type === 'image_url',
  );
}
async function runToTerminal(
  host: ImageHost,
  scope: { workspaceId: string; roomId: string },
  runId: string,
) {
  await settled(async () => host.client.getRun({ ...scope, runId }) ?? null);
  return host.client.getRun({ ...scope, runId });
}
async function sendAttached(
  host: ImageHost,
  roomId: string,
  bytes: Buffer,
  text: string,
  to: string | null = null,
) {
  const requestId = uuid();
  const info = await host.media.import(roomId, 'photo.png', bytes.toString('base64'));
  const receipt = await host.media.prepare(roomId, requestId, text, to, [info.id]);
  const submitted = await host.client.submit({
    workspaceId: WORKSPACE,
    roomId,
    requestId,
    text: receipt.prepared,
  });
  return { info, receipt, submitted };
}

describe('runtime image turn wire evidence', { timeout: 60_000 }, () => {
  it('sends the genuine PNG bytes and media type through the real runtime path', async () => {
    const { f, wire, host } = await fixture();
    const bytes = pngBytes(3, 2);
    const { info, submitted } = await sendAttached(host, f.flashRoom, bytes, 'Что на изображении?');
    expect(submitted.runId).not.toBeNull();
    const final = await runToTerminal(
      host,
      { workspaceId: WORKSPACE, roomId: f.flashRoom },
      submitted.runId!,
    );
    expect(final?.turnStatus).toBe('completed');
    // The real adapter serialized exactly one vendor request through the recording transport.
    expect(wire.calls).toHaveLength(1);
    const body = JSON.parse(wire.calls[0]!.body ?? '') as { model: string };
    expect(body.model).toBe('deepseek-flash');
    const messages = wireMessages(wire.calls[0]!);
    const last = messages.at(-1)!;
    expect(last.role).toBe('user');
    const parts = imagesOf(last.content);
    expect(parts).toHaveLength(1);
    const url = parts[0]!.image_url!.url;
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const payload = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    expect(sha(payload)).toBe(sha(bytes));
    expect(sha(payload)).toBe(info.sha256);
    const sentText = texts(last.content);
    expect(sentText).toContain('Что на изображении?');
    expect(sentText).not.toContain('[Ocean Desktop attachments');
    expect(JSON.stringify(messages)).not.toContain('[Ocean Desktop attachments');
    // The durable answer and usage are attributed to the same turn.
    const result = await host.client.getResult({
      workspaceId: WORKSPACE,
      roomId: f.flashRoom,
      runId: submitted.runId!,
    });
    expect(result?.body).toBe('Вижу изображение');
    const events = await host.client.listEvents({
      workspaceId: WORKSPACE,
      roomId: f.flashRoom,
      runId: submitted.runId!,
      after: 0,
      limit: 50,
    });
    expect(events.filter((event) => event.type === 'attempt.usage_recorded')).toHaveLength(1);
    // The display history still carries the renderer-facing marker body.
    const history = await host.client.history({
      workspaceId: WORKSPACE,
      roomId: f.flashRoom,
      after: 0,
      limit: 20,
    });
    expect(history.some((message) => message.body.includes('[Ocean Desktop attachments'))).toBe(
      true,
    );
  });

  it('refuses a text-only model with zero provider requests and no turn row', async () => {
    const { f, wire, host } = await fixture();
    const bytes = pngBytes(3, 2);
    const requestId = uuid();
    const info = await host.media.import(f.proRoom, 'photo.png', bytes.toString('base64'));
    const receipt = await host.media.prepare(f.proRoom, requestId, 'опиши', null, [info.id]);
    await expect(
      host.client.submit({
        workspaceId: WORKSPACE,
        roomId: f.proRoom,
        requestId,
        text: receipt.prepared,
      }),
    ).rejects.toThrow('model_image_unsupported');
    expect(wire.calls).toHaveLength(0);
    const history = await host.client.history({
      workspaceId: WORKSPACE,
      roomId: f.proRoom,
      after: 0,
      limit: 20,
    });
    expect(history).toHaveLength(0);
  });

  it('refuses images above 8192 px and aggregate raw bytes >34 MiB before dispatch', async () => {
    const { f, wire, host } = await fixture();
    for (const [bytes, text, expected] of [
      [pngBytes(9000, 1), 'слишком широко', 'image_too_large'],
      [pngBytes(1, 9000), 'слишком высоко', 'image_too_large'],
    ] as const) {
      const requestId = uuid();
      const info = await host.media.import(f.flashRoom, 'huge.png', bytes.toString('base64'));
      const receipt = await host.media.prepare(f.flashRoom, requestId, text, null, [info.id]);
      await expect(
        host.client.submit({
          workspaceId: WORKSPACE,
          roomId: f.flashRoom,
          requestId,
          text: receipt.prepared,
        }),
      ).rejects.toThrow(expected);
    }
    // Four 9 MiB genuine PNGs: raw sum exceeds the 34 MiB request budget.
    const requestId = uuid();
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const info = await host.media.import(
        f.flashRoom,
        'big' + String(index) + '.png',
        pngBytes(3, 2, 9 * 1024 * 1024).toString('base64'),
      );
      ids.push(info.id);
    }
    const receipt = await host.media.prepare(f.flashRoom, requestId, 'четыре файла', null, ids);
    await expect(
      host.client.submit({
        workspaceId: WORKSPACE,
        roomId: f.flashRoom,
        requestId,
        text: receipt.prepared,
      }),
    ).rejects.toThrow('image_too_large');
    expect(wire.calls).toHaveLength(0);
  });

  it('refuses corrupt, replaced and unbound Desktop images with zero provider requests', async () => {
    const { f, wire, host } = await fixture();
    const bytes = pngBytes(3, 2);
    const requestId = uuid();
    const info = await host.media.import(f.flashRoom, 'photo.png', bytes.toString('base64'));
    const receipt = await host.media.prepare(f.flashRoom, requestId, 'опиши', null, [info.id]);
    // Replaced blob bytes keep the durable metadata digest: authority must fail closed.
    const db = await import('node:sqlite');
    const database = new db.DatabaseSync(f.profile + '/runtime.sqlite');
    try {
      const binding = JSON.parse(
        String(
          database.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.[
            'value'
          ],
        ),
      ) as { root: string };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(binding.root + '/' + f.flashRoom + '/' + info.id + '/blob', pngBytes(4, 4), {
        mode: 0o600,
      });
    } finally {
      database.close();
    }
    await expect(
      host.client.submit({
        workspaceId: WORKSPACE,
        roomId: f.flashRoom,
        requestId,
        text: receipt.prepared,
      }),
    ).rejects.toThrow('image_unavailable');
    expect(wire.calls).toHaveLength(0);
  });
});
