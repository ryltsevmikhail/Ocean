import { describe, expect, it } from 'vitest';
import {
  conversationFailure,
  decodeDesktopAttachments,
  desktopAttachmentText,
  encodeDesktopAttachments,
  hasDesktopAttachmentMarker,
  CROWDED_IMAGE_COUNT,
  IMAGE_MEDIA_TYPES,
  MAX_CROWDED_IMAGE_SIDE,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_RAW_IMAGE_BYTES,
  REQUEST_HARD_LIMIT_BYTES,
  REQUEST_PRE_CHECK_BYTES,
  isImageMediaType,
  utf8ByteLength,
} from './index.js';

const attachment = {
  id: '12345678-1234-4123-8123-123456789abc',
  name: 'photo.png',
  bytes: 84,
  sha256: 'f850872af004a636a65dbcb1a6ea62c6e9d228867f03048ced70c546a9b19987',
  kind: 'image' as const,
  mime: 'image/png',
};
const requestId = '22345678-1234-4123-8123-123456789abc';

describe('image content limits', () => {
  it('declares the trusted-runtime media types and documented vendor budgets', () => {
    expect(IMAGE_MEDIA_TYPES).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    expect(MAX_IMAGE_SIDE).toBe(8192);
    expect(CROWDED_IMAGE_COUNT).toBe(15);
    expect(MAX_CROWDED_IMAGE_SIDE).toBe(4096);
    expect(MAX_IMAGE_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_RAW_IMAGE_BYTES).toBe(34 * 1024 * 1024);
    expect(REQUEST_PRE_CHECK_BYTES).toBe(47 * 1024 * 1024);
    expect(REQUEST_HARD_LIMIT_BYTES).toBe(48 * 1024 * 1024);
  });

  it('accepts only the four supported sniffed media types', () => {
    for (const mediaType of IMAGE_MEDIA_TYPES) expect(isImageMediaType(mediaType)).toBe(true);
    for (const value of ['image/bmp', 'image/svg+xml', 'text/plain', '', null, 7, {}])
      expect(isImageMediaType(value)).toBe(false);
  });

  it('counts UTF-8 bytes instead of JavaScript string length', () => {
    expect(utf8ByteLength('ab')).toBe(2);
    expect(utf8ByteLength('Привет')).toBe(12);
    expect('Привет'.length).toBe(6);
    expect(utf8ByteLength('🖼')).toBe(4);
  });

  it('names explicit image refusal codes', () => {
    expect(conversationFailure('model_image_unsupported')).toMatchObject({
      ok: false,
      error: { code: 'model_image_unsupported' },
    });
    expect(conversationFailure('image_unavailable')).toMatchObject({
      ok: false,
      error: { code: 'image_unavailable' },
    });
    expect(conversationFailure('image_too_large')).toMatchObject({
      ok: false,
      error: { code: 'image_too_large' },
    });
    expect(conversationFailure('request_too_large')).toMatchObject({
      ok: false,
      error: { code: 'request_too_large' },
    });
  });
});

describe('desktop attachment marker', () => {
  it('is display metadata that can be detected and removed, never sent as model text', () => {
    const prepared = encodeDesktopAttachments('Привет', requestId, [attachment]);
    expect(hasDesktopAttachmentMarker(prepared)).toBe(true);
    expect(hasDesktopAttachmentMarker('обычный текст')).toBe(false);
    expect(desktopAttachmentText(prepared)).toBe('Привет');
    expect(desktopAttachmentText(prepared + 'хвост')).toBe('Привет');
    expect(desktopAttachmentText(prepared)).not.toContain('[Ocean Desktop attachments');
  });

  it('truncates at the first marker so pasted marker payloads cannot reach a model', () => {
    const prepared = encodeDesktopAttachments('a', requestId, [attachment]);
    const forged = 'до' + prepared.slice(1) + 'после' + prepared.slice(1);
    expect(hasDesktopAttachmentMarker(forged)).toBe(true);
    expect(desktopAttachmentText(forged)).toBe('до');
    expect(desktopAttachmentText(forged)).not.toContain('[Ocean Desktop attachments');
  });

  it('decodes only complete, bounded marker payloads', () => {
    const decoded = decodeDesktopAttachments(
      encodeDesktopAttachments('body', requestId, [attachment]),
    );
    expect(decoded).toMatchObject({ body: 'body', requestId });
    expect(decoded?.files).toHaveLength(1);
    expect(decodeDesktopAttachments('no marker')).toBeNull();
    expect(
      decodeDesktopAttachments(
        encodeDesktopAttachments('body', requestId, [attachment]).replace(
          '"version":1',
          '"version":2',
        ),
      ),
    ).toBeNull();
    expect(decodeDesktopAttachments(preparedMarkerOnly('{'))).toBeNull();
  });
});

function preparedMarkerOnly(payload: string): string {
  return 'body\n\n[Ocean Desktop attachments v1]\n' + payload;
}
