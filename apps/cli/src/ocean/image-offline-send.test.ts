import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runOceanCommand } from './command.js';
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
  type ImageProfile,
} from '../../test-fixtures/image-host.test.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const NOTES = Buffer.from('exact fixture notes about the project');

function collector() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}
async function terminal(host: ImageHost, roomId: string, runId: string) {
  await settled(async () => host.client.getRun({ workspaceId: WORKSPACE, roomId, runId }) ?? null);
  return host.client.getRun({ workspaceId: WORKSPACE, roomId, runId });
}
async function attachedTurn(
  host: ImageHost,
  roomId: string,
  name: string,
  bytes: Buffer,
  text: string,
) {
  const requestId = uuid();
  const info = await host.media.import(roomId, name, bytes.toString('base64'));
  const receipt = await host.media.prepare(roomId, requestId, text, null, [info.id]);
  const submitted = await host.client.submit({
    workspaceId: WORKSPACE,
    roomId,
    requestId,
    text: receipt.prepared,
  });
  await terminal(host, roomId, submitted.runId!);
  return info;
}
function bindingRoot(profile: string): string {
  const database = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  try {
    const value = database
      .prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'")
      .get()?.['value'];
    return JSON.parse(String(value)).root as string;
  } finally {
    database.close();
  }
}

describe('offline CLI profile composition', { timeout: 60_000 }, () => {
  it('sends from a room with attachment history even when a text-file blob is gone', async () => {
    const f: ImageProfile = await imageProfile();
    const wire = imageProvider();
    const host = await startImageHost(f, wire.provider);
    cleanups.push(() => f.dispose());
    const png = pngBytes(4, 3, 0);
    let notes: { id: string };
    try {
      notes = await attachedTurn(host, f.flashRoom, 'notes.md', NOTES, 'посмотри заметки');
      await attachedTurn(host, f.flashRoom, 'photo.png', png, 'а теперь фото');
      await host.stop();
    } catch (error) {
      await host.stop().catch(() => undefined);
      throw error;
    }
    // The persisted text body already contains the snippet; its blob disappears.
    unlinkSync(join(bindingRoot(f.profile), f.flashRoom, notes.id, 'blob'));

    const offline = imageProvider();
    const output = collector();
    const error = collector();
    const code = await runOceanCommand(
      ['send', f.flashRoom, '--text', 'продолжаем без runtime', '--profile', f.profile, '--json'],
      { provider: offline.provider, output: output.stream, error: error.stream },
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(output.text()) as {
      ok: boolean;
      data: { status: string; runId: string | null };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe('completed');
    expect(error.text()).toBe('');
    // The offline host composes the same runtime image resolver: the historical image
    // is re-authenticated and the text attachment did not require its lost blob.
    expect(offline.calls).toHaveLength(1);
    const messages = wireMessages(offline.calls[0]!);
    const json = JSON.stringify(messages);
    expect(json).not.toContain('[Ocean Desktop attachments');
    expect(json).toContain('посмотри заметки');
    expect(json).toContain('exact fixture notes about the project');
    expect(json).toContain('продолжаем без runtime');
    const imageUrls = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === 'image_url')
      .map((part) => (part as { image_url: { url: string } }).image_url.url);
    expect(imageUrls).toHaveLength(1);
    expect(sha(Buffer.from(imageUrls[0]!.slice(imageUrls[0]!.indexOf(',') + 1), 'base64'))).toBe(
      sha(png),
    );
    // The runtime wrote the follow-up turn durably before the CLI exited.
    const reopened = new DatabaseSync(join(f.profile, 'runtime.sqlite'), { readOnly: true });
    try {
      const bodies = reopened
        .prepare("SELECT body FROM ocean_messages WHERE author='user' ORDER BY seq")
        .all()
        .map((row) => String(row['body']));
      expect(bodies.at(-1)).toBe('продолжаем без runtime');
      expect(bodies.filter((body) => body.includes('[Ocean Desktop attachments'))).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });
});
