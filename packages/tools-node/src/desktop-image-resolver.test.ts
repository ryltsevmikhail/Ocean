import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  PNG,
  cleanupImageAuthorityRoots,
  expectedFor,
  imageAuthorityFixture as fixture,
  persistMessage,
  resolveAuthority as resolve,
  sha,
} from '../test-fixtures/desktop-image-authority.test.js';

const REQUEST = '22345678-1234-4123-8123-123456789abc';
afterEach(cleanupImageAuthorityRoots);

describe('runtime Desktop image resolver', () => {
  it('resolves genuine persisted bytes and metadata through the durable preparation', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'Что на фото?', [info.id]);
    persistMessage(f, { id: 'msg1', body: receipt.prepared, requestId: REQUEST });
    const resolved = resolve(f, {
      messageId: 'msg1',
      body: receipt.prepared,
      requestId: REQUEST,
      expected: expectedFor(info),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw Error('expected images');
    expect(resolved.images).toHaveLength(1);
    expect(resolved.images[0]).toMatchObject({
      mediaType: 'image/png',
      attachmentId: info.id,
      roomId: f.roomId,
      sha256: sha(Buffer.from(PNG, 'base64')),
      width: 3,
      height: 2,
    });
    expect(Buffer.from(resolved.images[0]!.bytes).equals(Buffer.from(PNG, 'base64'))).toBe(true);
  });

  it('admits the same authority while the admission transaction is committing', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'Что на фото?', [info.id]);
    expect(
      resolve(f, {
        messageId: 'not-persisted-yet',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
        phase: 'committing',
      }),
    ).toMatchObject({ ok: true });
    expect(
      resolve(f, {
        messageId: 'not-persisted-yet',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
      }),
    ).toMatchObject({ ok: false, code: 'image_unavailable' });
  });

  it('refuses cross-room requests and forged marker claims', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'Что на фото?', [info.id]);
    persistMessage(f, { id: 'msg1', body: receipt.prepared, requestId: REQUEST });
    expect(
      resolve(f, {
        messageId: 'msg1',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: [{ id: '99999999-9999-4999-8999-999999999999', sha256: info.sha256 }],
      }),
    ).toMatchObject({ ok: false, code: 'image_unavailable' });
    expect(
      resolve(f, {
        messageId: 'msg1',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
        roomId: f.otherRoomId,
      }),
    ).toMatchObject({ ok: false, code: 'image_unavailable' });
  });

  it('re-resolves the identical persisted image after an owner restart', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'Что на фото?', [info.id]);
    persistMessage(f, { id: 'msg1', body: receipt.prepared, requestId: REQUEST });
    const first = resolve(f, {
      messageId: 'msg1',
      body: receipt.prepared,
      requestId: REQUEST,
      expected: expectedFor(info),
    });
    expect(first).toMatchObject({ ok: true });
    f.reopen();
    expect(
      resolve(f, {
        messageId: 'msg1',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
      }),
    ).toEqual(first);
    fs.rmSync(join(f.binding().root, f.roomId), { recursive: true, force: true });
    expect(
      resolve(f, {
        messageId: 'msg1',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
      }),
    ).toMatchObject({ ok: false, code: 'image_unavailable' });
  });
});
