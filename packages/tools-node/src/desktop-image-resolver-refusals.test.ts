import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeDesktopAttachments, type DesktopAttachment } from '@runnets/domain';
import {
  GIF,
  cleanupImageAuthorityRoots,
  craftedPng,
  expectedFor,
  imageAuthorityFixture as fixture,
  persistMessage,
  resolveAuthority as resolve,
  sha,
} from '../test-fixtures/desktop-image-authority.test.js';

const REQUEST = '22345678-1234-4123-8123-123456789abc';
afterEach(cleanupImageAuthorityRoots);
function writeCrafted(
  f: ReturnType<typeof fixture>,
  id: string,
  requestId: string,
  bytes: Buffer,
  mime = 'image/png',
) {
  const root = f.binding().root;
  fs.mkdirSync(join(root, f.roomId), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(root, f.roomId, id), { mode: 0o700 });
  fs.writeFileSync(join(root, f.roomId, id, 'blob'), bytes, { mode: 0o600 });
  const info: DesktopAttachment = {
    id,
    name: 'crafted.png',
    bytes: bytes.length,
    sha256: sha(bytes),
    kind: 'image',
    mime,
  };
  fs.writeFileSync(join(root, f.roomId, id, 'metadata.json'), JSON.stringify(info), {
    mode: 0o600,
  });
  const body = encodeDesktopAttachments('Что на фото?', requestId, [info]);
  f.insertPreparation(f.roomId, requestId, {
    digest: sha(body),
    ids: [id],
    body: 'Что на фото?',
    to: null,
    prepared: body,
  });
  return { info, body };
}

describe('runtime Desktop image refusals', () => {
  it('refuses missing, replaced, corrupted or covered-over blob bytes', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'Что на фото?', [info.id]);
    persistMessage(f, { id: 'msg1', body: receipt.prepared, requestId: REQUEST });
    const dir = join(f.binding().root, f.roomId, info.id);
    const blob = join(dir, 'blob');
    const metadata = join(dir, 'metadata.json');
    const originalBlob = fs.readFileSync(blob);
    const originalMetadata = fs.readFileSync(metadata);
    const run = (expected = expectedFor(info), body = receipt.prepared) =>
      resolve(f, { messageId: 'msg1', body, requestId: REQUEST, expected });
    expect(run()).toMatchObject({ ok: true });
    fs.writeFileSync(blob, Buffer.from(GIF, 'base64'), { mode: 0o600 });
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(blob, originalBlob.subarray(0, 10), { mode: 0o600 });
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(blob, originalBlob, { mode: 0o600 });
    fs.unlinkSync(blob);
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(blob, originalBlob, { mode: 0o600 });
    fs.unlinkSync(metadata);
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(metadata, originalMetadata, { mode: 0o600 });
    expect(run([{ id: info.id, sha256: sha('forged') }])).toMatchObject({
      ok: false,
      code: 'image_unavailable',
    });
    expect(run(expectedFor(info), receipt.prepared + 'tail')).toMatchObject({
      ok: false,
      code: 'image_unavailable',
    });
    // A replacement that rewrites metadata consistently still differs from the marker hash.
    fs.writeFileSync(blob, Buffer.from(GIF, 'base64'), { mode: 0o600 });
    fs.writeFileSync(
      metadata,
      JSON.stringify({
        ...JSON.parse(originalMetadata.toString('utf8')),
        bytes: Buffer.from(GIF, 'base64').length,
        sha256: sha(Buffer.from(GIF, 'base64')),
      }),
      { mode: 0o600 },
    );
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
  });

  it('refuses unsupported formats and images above the trusted 8192-pixel limit', () => {
    const f = fixture();
    const cases = [
      { bytes: Buffer.from('BM' + '\0'.repeat(60), 'ascii'), code: 'image_unavailable' },
      { bytes: craftedPng(9000, 1), code: 'image_too_large' },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const id = '12345678-1234-4123-8123-1234567890' + String(index).padStart(2, '0');
      const requestId = '22345678-1234-4123-8123-1234567890' + String(index).padStart(2, '0');
      const { info, body } = writeCrafted(f, id, requestId, testCase.bytes);
      const messageId = 'msg-' + String(index);
      persistMessage(f, { id: messageId, body, requestId });
      expect(resolve(f, { messageId, body, requestId, expected: expectedFor(info) })).toMatchObject(
        { ok: false, code: testCase.code },
      );
    }
  });

  it('accepts the exact 8192-pixel side and refuses only above it', () => {
    const f = fixture();
    const { info, body } = writeCrafted(
      f,
      '12345678-1234-4123-8123-1234567890aa',
      REQUEST,
      craftedPng(8192, 2),
    );
    persistMessage(f, { id: 'msg-boundary', body, requestId: REQUEST });
    const resolved = resolve(f, {
      messageId: 'msg-boundary',
      body,
      requestId: REQUEST,
      expected: expectedFor(info),
    });
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw Error('expected image');
    expect(resolved.images[0]).toMatchObject({ width: 8192, height: 2 });
  });

  it('accepts an adopted pre-enrollment message bound by enrollment evidence', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'старое вложение', [info.id]);
    persistMessage(f, {
      id: 'msg-adopted',
      body: receipt.prepared,
      requestId: REQUEST,
      receipt: false,
    });
    f.close();
    const db = new DatabaseSync(f.path);
    try {
      db.prepare('INSERT INTO ocean_desktop_adopted VALUES(?,?,?,?)').run(
        'msg-adopted',
        f.roomId,
        REQUEST,
        receipt.prepared,
      );
    } finally {
      db.close();
    }
    f.reopen();
    expect(
      resolve(f, {
        messageId: 'msg-adopted',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a Desktop binding whose root or identity no longer verifies', () => {
    const f = fixture();
    const info = f.importImage();
    const receipt = f.prepare(REQUEST, 'Что на фото?', [info.id]);
    persistMessage(f, { id: 'msg1', body: receipt.prepared, requestId: REQUEST });
    const original = f.binding();
    f.close();
    const db = new DatabaseSync(f.path);
    try {
      db.prepare("UPDATE meta SET value=? WHERE key='desktop_assets_binding'").run(
        JSON.stringify({ ...original, identity: '0:0:0:0:0:1' }),
      );
    } finally {
      db.close();
    }
    f.reopen();
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
