import { describe, expect, it } from 'vitest';
import { resolveMessageContent } from './image-content.js';
import {
  TINY_IMAGES,
  imageContent,
  messageText,
  resolveFail,
  resolveOk,
  resolveUnbound,
  resolverStub,
  sha256,
  tinyImage,
} from '../test-fixtures/image-content-fakes.js';
import { encodeDesktopAttachments, type DesktopAttachment } from '@runnets/domain';

const requestId = '22345678-1234-4123-8123-123456789abc';
const attachment: DesktopAttachment = {
  id: '12345678-1234-4123-8123-123456789abc',
  name: 'photo.png',
  bytes: Buffer.from(TINY_IMAGES['image/png'], 'base64').length,
  sha256: sha256(Buffer.from(TINY_IMAGES['image/png'], 'base64')),
  kind: 'image',
  mime: 'image/png',
};
const prepared = encodeDesktopAttachments('Что на изображении?', requestId, [attachment]);
const scope = {
  workspaceId: 'ws_ocean',
  roomId: 'room-1',
  messageId: 'msg-1',
  body: prepared,
  phase: 'persisted' as const,
};

describe('message content resolution', () => {
  it('keeps legacy plain text as an unchanged string and never calls the resolver', () => {
    const resolver = resolverStub(resolveOk(tinyImage()));
    const resolved = resolveMessageContent({ ...scope, body: 'просто текст' }, resolver);
    expect(resolved).toEqual({ ok: true, value: 'просто текст' });
    expect(resolver.requests).toHaveLength(0);
  });

  it('asks the runtime resolver for the exact persisted message identity and returns image parts', () => {
    const resolver = resolverStub(resolveOk(tinyImage()));
    const resolved = resolveMessageContent(scope, resolver);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw Error('expected content');
    expect(resolver.requests).toEqual([
      {
        workspaceId: 'ws_ocean',
        roomId: 'room-1',
        messageId: 'msg-1',
        body: prepared,
        requestId,
        expected: [{ id: attachment.id, sha256: attachment.sha256 }],
        phase: 'persisted',
      },
    ]);
    expect(resolved.value).toEqual(imageContent('Что на изображении?', tinyImage()));
    if (typeof resolved.value === 'string') throw Error('expected parts');
    expect(messageText(resolved.value)).toBe('Что на изображении?');
    expect(JSON.stringify(resolved.value)).not.toContain('[Ocean Desktop attachments');
  });

  it('refuses a marker when the host has no runtime image resolver', () => {
    expect(resolveMessageContent(scope, undefined)).toMatchObject({
      ok: false,
      error: { code: 'image_unavailable' },
    });
  });

  it('strips a malformed or truncated marker to its visible text and never leaks the payload', () => {
    const malformed = 'текст\n\n[Ocean Desktop attachments v1]\n{"version":1}';
    const resolver = resolverStub(resolveOk(tinyImage()));
    // History reconstruction keeps the room usable: the marker body is inert text.
    expect(resolveMessageContent({ ...scope, body: malformed }, resolver)).toEqual({
      ok: true,
      value: 'текст',
    });
    expect(resolver.requests).toHaveLength(0);
    // A fresh admission still fails closed.
    expect(
      resolveMessageContent({ ...scope, body: malformed, phase: 'committing' }, resolver),
    ).toMatchObject({ ok: false, error: { code: 'image_unavailable' } });
  });

  it('strips a marker with no durable binding on reconstruction but refuses it on admission', () => {
    const resolver = resolverStub(resolveUnbound());
    // No preparation/message↔request binding: the body was never an image message.
    expect(resolveMessageContent(scope, resolver)).toEqual({
      ok: true,
      value: 'Что на изображении?',
    });
    expect(resolver.requests).toHaveLength(1);
    expect(
      resolveMessageContent(
        { ...scope, admittedRequestId: requestId, phase: 'committing' },
        resolver,
      ),
    ).toMatchObject({ ok: false, error: { code: 'image_unavailable' } });
  });

  it('propagates the resolver refusal code without calling the provider', () => {
    for (const code of ['image_unavailable', 'image_too_large'] as const) {
      const resolver = resolverStub(resolveFail(code));
      expect(resolveMessageContent(scope, resolver)).toMatchObject({
        ok: false,
        error: { code },
      });
    }
  });

  it('keeps a text-only attachment message as a string without image parts', () => {
    const textFile: DesktopAttachment = { ...attachment, kind: 'file', mime: 'text/plain' };
    const body = encodeDesktopAttachments('смотри файл', requestId, [textFile]);
    const resolved = resolveMessageContent({ ...scope, body }, resolverStub(resolveOk()));
    expect(resolved).toEqual({ ok: true, value: 'смотри файл' });
  });
});
