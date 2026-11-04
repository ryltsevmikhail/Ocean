import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { DesktopAttachment } from '@runnets/domain';
import {
  cleanupImageAuthorityRoots,
  expectedFor,
  imageAuthorityFixture as fixture,
  persistMessage,
  resolveAuthority as resolve,
  sha,
} from '../test-fixtures/desktop-image-authority.test.js';

const NOTES = Buffer.from('exact fixture notes about the project');
const REQUEST = '22345678-1234-4123-8123-123456789abc';
const PHOTO_REQUEST = '32345678-1234-4123-8123-123456789abc';
afterEach(cleanupImageAuthorityRoots);

function persistTextAttachment(f: ReturnType<typeof fixture>) {
  const info = f.files.import(f.binding(), f.roomId, 'notes.md', NOTES.toString('base64'));
  const receipt = f.prepare(REQUEST, 'посмотри заметки', [info.id]);
  persistMessage(f, { id: 'msg-notes', body: receipt.prepared, requestId: REQUEST });
  return { info, receipt };
}
function paths(f: ReturnType<typeof fixture>, info: DesktopAttachment) {
  const dir = join(f.binding().root, f.roomId, info.id);
  return { dir, blob: join(dir, 'blob'), metadata: join(dir, 'metadata.json') };
}

describe('text attachment reconstruction compatibility', () => {
  it('keeps later turns working when a text-file blob is missing or replaced', () => {
    const f = fixture();
    const { info, receipt } = persistTextAttachment(f);
    const files = paths(f, info);
    const run = () =>
      resolve(f, {
        messageId: 'msg-notes',
        body: receipt.prepared,
        requestId: REQUEST,
        expected: expectedFor(info),
      });
    expect(run()).toEqual({ ok: true, images: [] });
    // The snippet is baked into the persisted body; a missing blob must not fail the turn.
    fs.unlinkSync(files.blob);
    expect(run()).toEqual({ ok: true, images: [] });
    // A replaced/corrupt blob likewise: no model bytes come from a non-image attachment.
    fs.writeFileSync(files.blob, Buffer.from('replaced fixture bytes'), { mode: 0o600 });
    expect(run()).toEqual({ ok: true, images: [] });
    // Metadata is still part of the authority chain for every attachment kind.
    fs.unlinkSync(files.metadata);
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
  });

  it('keeps the strict blob re-hash for actual images next to text attachments', () => {
    const f = fixture();
    persistTextAttachment(f);
    const info = f.importImage();
    const receipt = f.prepare(PHOTO_REQUEST, 'посмотри фото', [info.id]);
    persistMessage(f, { id: 'msg-photo', body: receipt.prepared, requestId: PHOTO_REQUEST });
    const files = paths(f, info);
    const run = () =>
      resolve(f, {
        messageId: 'msg-photo',
        body: receipt.prepared,
        requestId: PHOTO_REQUEST,
        expected: expectedFor(info),
      });
    expect(run()).toMatchObject({ ok: true });
    const original = fs.readFileSync(files.blob);
    fs.unlinkSync(files.blob);
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(files.blob, Buffer.from('replaced image bytes'), { mode: 0o600 });
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(files.blob, original.subarray(0, 10), { mode: 0o600 });
    expect(run()).toMatchObject({ ok: false, code: 'image_unavailable' });
    fs.writeFileSync(files.blob, original, { mode: 0o600 });
    expect(run()).toMatchObject({ ok: true });
    // The image's own digest is still recomputed from the bytes, not read from the marker.
    expect(sha(fs.readFileSync(files.blob))).toBe(info.sha256);
  });
});
