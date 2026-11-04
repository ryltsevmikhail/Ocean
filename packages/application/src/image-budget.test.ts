import { describe, expect, it } from 'vitest';
import { admitImageRequest, imageRefusalCode, messageImageParts } from './image-content.js';
import {
  DEEPSEEK_MODEL_INFO,
  TINY_IMAGES,
  sha256,
  imageContent,
  recordingProvider,
  requestBytesFallback,
  resolveOk,
  tinyImage,
} from '../test-fixtures/image-content-fakes.js';
import type { ImageResolveResult } from './image-content.js';
import type { DesktopAttachment } from '@runnets/domain';

const attachment: DesktopAttachment = {
  id: '12345678-1234-4123-8123-123456789abc',
  name: 'photo.png',
  bytes: Buffer.from(TINY_IMAGES['image/png'], 'base64').length,
  sha256: sha256(Buffer.from(TINY_IMAGES['image/png'], 'base64')),
  kind: 'image',
  mime: 'image/png',
};

describe('image request admission', () => {
  const provider = () =>
    recordingProvider({
      modelInfo: DEEPSEEK_MODEL_INFO,
      requestBytes: requestBytesFallback,
    });

  it('admits an image request for the vision model and reports the verified parts', () => {
    const admitted = admitImageRequest({
      provider: provider(),
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: imageContent('вопрос', tinyImage()) }],
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw Error('expected admission');
    expect(admitted.value).toHaveLength(1);
    expect(admitted.value[0]?.mediaType).toBe('image/png');
    expect(admitted.value[0]?.bytes.byteLength).toBe(attachment.bytes);
  });

  it('refuses a text-only model visibly and never falls back to another model', () => {
    const fake = provider();
    const result = admitImageRequest({
      provider: fake,
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: imageContent('вопрос', tinyImage()) }],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'model_image_unsupported' } });
    expect(fake.requests).toHaveLength(0);
    // No automatic model/account switch: the refusal is final for the selected model.
    expect(fake.models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('refuses when the provider cannot bound its serialized request', () => {
    const fake = recordingProvider({ modelInfo: DEEPSEEK_MODEL_INFO });
    expect(
      admitImageRequest({
        provider: fake,
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: imageContent('вопрос', tinyImage()) }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'model_image_unsupported' } });
  });

  it('leaves text-only requests untouched for every model', () => {
    const fake = provider();
    for (const model of ['deepseek-flash', 'deepseek-v4-pro'])
      expect(
        admitImageRequest({
          provider: fake,
          model,
          messages: [{ role: 'user', content: 'текст' }],
        }),
      ).toMatchObject({ ok: true });
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses aggregate raw bytes above the 34 MiB request budget', () => {
    const big = tinyImage('image/png', {
      bytes: new Uint8Array(9 * 1024 * 1024),
      sha256: 'a'.repeat(64),
    });
    const messages = [
      { role: 'user' as const, content: imageContent('a', big) },
      { role: 'user' as const, content: imageContent('b', big) },
      { role: 'user' as const, content: imageContent('c', big) },
      { role: 'user' as const, content: imageContent('d', big) },
    ];
    expect(
      admitImageRequest({ provider: provider(), model: 'deepseek-flash', messages }),
    ).toMatchObject({ ok: false, error: { code: 'image_too_large' } });
    // The exact 34 MiB boundary is admitted (4 x 8.5 MiB, each within 10 MiB).
    const okay = tinyImage('image/png', {
      bytes: new Uint8Array((34 * 1024 * 1024) / 4),
      sha256: 'b'.repeat(64),
    });
    const boundary = Array.from({ length: 4 }, () => ({
      role: 'user' as const,
      content: imageContent('a', okay),
    }));
    expect(
      admitImageRequest({
        provider: recordingProvider({ modelInfo: DEEPSEEK_MODEL_INFO, requestBytes: () => 1024 }),
        model: 'deepseek-flash',
        messages: boundary,
      }),
    ).toMatchObject({ ok: true });
  });

  it('enforces per-image bytes and the documented 8192-pixel side limit', () => {
    const cases = [
      tinyImage('image/png', { bytes: new Uint8Array(10 * 1024 * 1024 + 1) }),
      tinyImage('image/png', { width: 8193 }),
      tinyImage('image/png', { height: 8193 }),
      tinyImage('image/png', { width: 0 }),
      tinyImage('image/png', { mediaType: 'image/bmp' as never }),
      tinyImage('image/png', { sha256: 'not-a-digest' }),
    ];
    for (const image of cases)
      expect(
        admitImageRequest({
          provider: provider(),
          model: 'deepseek-flash',
          messages: [{ role: 'user', content: imageContent('a', image) }],
        }),
      ).toMatchObject({ ok: false });
    // Exactly 8192 px is accepted (only above the documented side limit is refused).
    expect(
      admitImageRequest({
        provider: provider(),
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: imageContent('a', tinyImage('image/png', { width: 8192 })) },
        ],
      }),
    ).toMatchObject({ ok: true });
  });

  it('counts historical images and their exact serialized UTF-8 body', () => {
    const messages = [
      { role: 'user' as const, content: imageContent('Первый вопрос', tinyImage()) },
      { role: 'assistant' as const, content: 'Ответ' },
      { role: 'user' as const, content: imageContent('Второй вопрос', tinyImage('image/jpeg')) },
    ];
    expect(messageImageParts(messages[0]!)).toHaveLength(1);
    expect(messageImageParts(messages[1]!)).toHaveLength(0);
    expect(
      admitImageRequest({ provider: provider(), model: 'deepseek-flash', messages }),
    ).toMatchObject({ ok: true });
    // UTF-8 is counted in bytes: the Cyrillic caption alone exceeds its char count.
    const base = requestBytesFallback({ model: 'deepseek-flash', messages: [] });
    const cyrillic = requestBytesFallback({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Привет' }],
    });
    expect(cyrillic - base).toBeGreaterThan('Привет'.length);
  });

  it('refuses a pre-checked serialized body above 47 MiB before any dispatch', () => {
    const fake = recordingProvider({
      modelInfo: DEEPSEEK_MODEL_INFO,
      requestBytes: () => 47 * 1024 * 1024 + 1,
    });
    expect(
      admitImageRequest({
        provider: fake,
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: imageContent('a', tinyImage()) }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'request_too_large' } });
    expect(fake.requests).toHaveLength(0);
  });

  it('applies the vendor 4096-pixel limit once a request carries 15 or more images', () => {
    const image = tinyImage('image/png', { width: 5000 });
    const messages = Array.from({ length: 15 }, () => ({
      role: 'user' as const,
      content: imageContent('a', image),
    }));
    expect(
      admitImageRequest({ provider: provider(), model: 'deepseek-flash', messages }),
    ).toMatchObject({ ok: false, error: { code: 'image_too_large' } });
    const small = tinyImage('image/png', { width: 4096 });
    const crowded = Array.from({ length: 15 }, () => ({
      role: 'user' as const,
      content: imageContent('a', small),
    }));
    expect(
      admitImageRequest({ provider: provider(), model: 'deepseek-flash', messages: crowded }),
    ).toMatchObject({ ok: true });
  });

  it('exposes one refusal-code projection for both chat and broadcast admission', () => {
    const fake = provider();
    expect(
      imageRefusalCode(fake, 'deepseek-v4-pro', [
        { role: 'user', content: imageContent('a', tinyImage()) },
      ]),
    ).toBe('model_image_unsupported');
    expect(
      imageRefusalCode(fake, 'deepseek-flash', [{ role: 'user', content: 'текст' }]),
    ).toBeNull();
  });
});

describe('resolver result shape', () => {
  it('never accepts an image part in a system, assistant or tool message', () => {
    const result: ImageResolveResult = resolveOk(tinyImage());
    expect(result.ok).toBe(true);
    for (const role of ['system', 'assistant', 'tool'] as const) {
      expect(
        admitImageRequest({
          provider: recordingProvider({
            modelInfo: DEEPSEEK_MODEL_INFO,
            requestBytes: requestBytesFallback,
          }),
          model: 'deepseek-flash',
          messages: [{ role, content: imageContent('a', tinyImage()) }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'image_unavailable' } });
    }
  });
});
