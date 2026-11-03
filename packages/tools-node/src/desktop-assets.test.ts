import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  captureDesktopAssets,
  archiveDesktopAssets,
  verifyDesktopAssetArchive,
  restoreDesktopAssets,
  desktopRootIdentity,
} from './desktop-assets.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function fixture() {
  const parent = fs.mkdtempSync(join(tmpdir(), 'desktop-assets-'));
  roots.push(parent);
  const root = join(parent, 'source');
  fs.mkdirSync(root, { mode: 0o700 });
  const room = 'room_one',
    id = '12345678-1234-4123-8123-123456789abc',
    requestId = '22345678-1234-4123-8123-123456789abc';
  fs.mkdirSync(join(root, room), { mode: 0o700 });
  fs.mkdirSync(join(root, room, id), { mode: 0o700 });
  const info = {
    id,
    name: 'notes.md',
    bytes: 5,
    sha256: hash('hello'),
    kind: 'file' as const,
    mime: 'text/plain',
  };
  const prepared =
    'caption\n\n[Ocean Desktop attachments v1]\n' +
    JSON.stringify({ version: 1, requestId, files: [info] });
  const receipt = { ids: [id], body: 'caption', to: null, prepared, digest: hash(prepared) };
  fs.writeFileSync(join(root, room, id, 'blob'), 'hello', { mode: 0o600 });
  fs.writeFileSync(join(root, room, id, 'metadata.json'), JSON.stringify(info), { mode: 0o600 });
  fs.writeFileSync(join(root, room, requestId + '.json'), JSON.stringify(receipt), { mode: 0o600 });
  const inventory = {
    format: 1 as const,
    binding: {
      profileId: hash('/synthetic/profile'),
      root,
      identity: desktopRootIdentity(root),
      originalRoot: root,
    },
    rooms: [room],
    messages: [
      {
        id: 'message_one',
        roomId: room,
        requestId,
        body: prepared,
        requestBinding: JSON.stringify(['SendDirect', 'ws_ocean', room, prepared]),
        requestReply: JSON.stringify({
          kind: 'message',
          data: { id: 'message_one', roomId: room, workspaceId: 'ws_ocean' },
        }),
      },
    ],
    operations: [],
    uploads: [],
  };
  return { parent, root, room, id, requestId, receipt, inventory };
}
it('captures full prepared-body association and restores without any original source', () => {
  const f = fixture();
  const capture = captureDesktopAssets(f.inventory);
  const archive = join(f.parent, 'archive');
  archiveDesktopAssets(capture, archive);
  fs.rmSync(f.root, { recursive: true });
  const catalog = verifyDesktopAssetArchive(archive);
  expect(catalog.inventory.messages[0]?.body).toBe(f.receipt.prepared);
  const output = join(f.parent, 'quarantine');
  restoreDesktopAssets(archive, output);
  expect(fs.readFileSync(join(output, 'tree', f.room, f.id, 'blob'), 'utf8')).toBe('hello');
  expect(
    JSON.parse(fs.readFileSync(join(output, 'tree', f.room, f.requestId + '.json'), 'utf8')),
  ).toEqual(f.receipt);
  expect(fs.statSync(join(output, 'tree', f.room, f.id, 'blob')).mode & 0o777).toBe(0o600);
});
it('refuses required missing bytes, wrong prepared digest, and a forged capture handle', () => {
  const f = fixture();
  const cap = captureDesktopAssets(f.inventory);
  expect(() => archiveDesktopAssets(structuredClone(cap), join(f.parent, 'forged'))).toThrow(
    'invalid_desktop_capture',
  );
  fs.writeFileSync(
    join(f.root, f.room, f.requestId + '.json'),
    JSON.stringify({ ...f.receipt, digest: hash('forged') }),
  );
  expect(() => captureDesktopAssets(f.inventory)).toThrow('desktop_asset_corrupted');
  fs.unlinkSync(join(f.root, f.room, f.id, 'blob'));
  expect(() => captureDesktopAssets(f.inventory)).toThrow();
});
it('refuses protected namespaces and external hardlinks in full-set preflight', () => {
  const f = fixture();
  fs.writeFileSync(join(f.root, '.env'), 'forbidden', { mode: 0o600 });
  expect(() => captureDesktopAssets(f.inventory)).toThrow('protected_desktop_asset');
  fs.unlinkSync(join(f.root, '.env'));
  fs.linkSync(join(f.root, f.room, f.id, 'blob'), join(f.parent, 'outside'));
  expect(() => captureDesktopAssets(f.inventory)).toThrow('protected_desktop_asset');
});
it('refuses changed source after capture and independently corrupt archived bytes', () => {
  const f = fixture();
  const cap = captureDesktopAssets(f.inventory);
  fs.writeFileSync(join(f.root, f.room, f.id, 'blob'), 'other');
  expect(() => archiveDesktopAssets(cap, join(f.parent, 'stale'))).toThrow();
  fs.writeFileSync(join(f.root, f.room, f.id, 'blob'), 'hello');
  const archive = join(f.parent, 'archive');
  archiveDesktopAssets(captureDesktopAssets(f.inventory), archive);
  fs.writeFileSync(join(archive, 'assets', 'blobs', hash('hello')), 'other');
  expect(() => verifyDesktopAssetArchive(archive)).toThrow();
});
it('independent verification refuses a self-consistent archive with nonprivate Desktop modes', () => {
  const f = fixture(),
    archive = join(f.parent, 'archive');
  archiveDesktopAssets(captureDesktopAssets(f.inventory), archive);
  const manifestPath = join(archive, 'assets', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.entries.find((entry: { path: string }) => entry.path.endsWith('/blob')).mode = 0o644;
  const { hash: _oldManifestHash, ...manifestBody } = manifest;
  manifest.hash = hash(JSON.stringify(manifestBody));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const catalogPath = join(archive, 'catalog.json'),
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  catalog.manifest = manifest;
  const { hash: _oldCatalogHash, ...catalogBody } = catalog;
  catalog.hash = hash(JSON.stringify(catalogBody));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  expect(() => verifyDesktopAssetArchive(archive)).toThrow('protected_desktop_asset');
});
it('retains private incomplete upload and unlinked preparation evidence without repairing source', () => {
  const f = fixture(),
    unfinished = join(f.root, f.room, '.upload-abcdef');
  fs.mkdirSync(unfinished, { mode: 0o700 });
  fs.writeFileSync(join(unfinished, 'blob'), 'partial', { mode: 0o600 });
  const temp = f.requestId + '.json.32345678-1234-4123-8123-123456789abc.tmp';
  fs.writeFileSync(join(f.root, f.room, temp), '{partial', { mode: 0o600 });
  const archive = join(f.parent, 'archive');
  archiveDesktopAssets(captureDesktopAssets(f.inventory), archive);
  const output = join(f.parent, 'restored');
  restoreDesktopAssets(archive, output);
  expect(fs.readFileSync(join(output, 'tree', f.room, '.upload-abcdef', 'blob'), 'utf8')).toBe(
    'partial',
  );
  expect(fs.readFileSync(join(output, 'tree', f.room, temp), 'utf8')).toBe('{partial');
  expect(fs.readFileSync(join(f.root, f.room, temp), 'utf8')).toBe('{partial');
});
it('roundtrips exact image and binary bytes, original names and a two-file history binding', () => {
  const f = fixture(),
    imageId = '42345678-1234-4123-8123-123456789abc';
  const binary = Buffer.from([0, 255, 128, 13, 10]),
    png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=',
      'base64',
    );
  const file = {
    id: f.id,
    name: 'original bytes.bin',
    bytes: binary.length,
    sha256: hash(binary),
    kind: 'file',
    mime: 'application/octet-stream',
  };
  const image = {
    id: imageId,
    name: 'исходное изображение.png',
    bytes: png.length,
    sha256: hash(png),
    kind: 'image',
    mime: 'image/png',
  };
  fs.writeFileSync(join(f.root, f.room, f.id, 'blob'), binary);
  fs.writeFileSync(join(f.root, f.room, f.id, 'metadata.json'), JSON.stringify(file));
  fs.mkdirSync(join(f.root, f.room, imageId), { mode: 0o700 });
  fs.writeFileSync(join(f.root, f.room, imageId, 'blob'), png, { mode: 0o600 });
  fs.writeFileSync(join(f.root, f.room, imageId, 'metadata.json'), JSON.stringify(image), {
    mode: 0o600,
  });
  const body =
    'caption\n\n[Ocean Desktop attachments v1]\n' +
    JSON.stringify({ version: 1, requestId: f.requestId, files: [file, image] });
  const receipt = {
    body: 'caption',
    ids: [f.id, imageId],
    to: null,
    prepared: body,
    digest: hash(body),
  };
  fs.writeFileSync(join(f.root, f.room, f.requestId + '.json'), JSON.stringify(receipt));
  const inventory = {
    ...f.inventory,
    messages: [
      {
        ...f.inventory.messages[0]!,
        body,
        requestBinding: JSON.stringify(['SendDirect', 'ws_ocean', f.room, body]),
      },
    ],
  };
  const archive = join(f.parent, 'archive');
  archiveDesktopAssets(captureDesktopAssets(inventory), archive);
  fs.rmSync(f.root, { recursive: true });
  const output = join(f.parent, 'restore');
  const catalog = restoreDesktopAssets(archive, output);
  expect(fs.readFileSync(join(output, 'tree', f.room, f.id, 'blob'))).toEqual(binary);
  expect(fs.readFileSync(join(output, 'tree', f.room, imageId, 'blob'))).toEqual(png);
  expect(
    JSON.parse(fs.readFileSync(join(output, 'tree', f.room, imageId, 'metadata.json'), 'utf8'))
      .name,
  ).toBe('исходное изображение.png');
  expect(catalog.inventory.messages[0]?.body).toBe(body);
});
it.each(['missing', 'changed-original-body'])(
  'refuses %s evidence for a durably completed but unsent preparation',
  (kind) => {
    const f = fixture();
    const operation = {
      id: 'prepare:' + f.room + ':' + f.requestId,
      binding: JSON.stringify({
        room: f.room,
        requestId: f.requestId,
        body: f.receipt.body,
        to: null,
        ids: [f.id],
      }),
      state: 'completed' as const,
      result: JSON.stringify(f.receipt),
    };
    const inventory = { ...f.inventory, messages: [], operations: [operation] };
    const path = join(f.root, f.room, f.requestId + '.json');
    if (kind === 'missing') fs.unlinkSync(path);
    else fs.writeFileSync(path, JSON.stringify({ ...f.receipt, body: 'changed' }));
    expect(() => captureDesktopAssets(inventory)).toThrow('desktop_asset_corrupted');
  },
);

it('retains the exact started preparation link/unlink pair after source deletion', () => {
  const f = fixture(),
    canonical = f.requestId + '.json',
    temporary = canonical + '.32345678-1234-4123-8123-123456789abc.tmp';
  fs.linkSync(join(f.root, f.room, canonical), join(f.root, f.room, temporary));
  const inventory = {
    ...f.inventory,
    messages: [],
    operations: [
      {
        id: 'prepare:' + f.room + ':' + f.requestId,
        binding: JSON.stringify({
          room: f.room,
          requestId: f.requestId,
          body: f.receipt.body,
          to: null,
          ids: [f.id],
        }),
        state: 'started' as const,
        result: null,
      },
    ],
  };
  const archive = join(f.parent, 'alias-archive');
  archiveDesktopAssets(captureDesktopAssets(inventory), archive);
  fs.rmSync(f.root, { recursive: true });
  expect(verifyDesktopAssetArchive(archive).inventory.operations[0]?.state).toBe('started');
  const output = join(f.parent, 'alias-quarantine');
  restoreDesktopAssets(archive, output);
  const first = join(output, 'tree', f.room, canonical),
    second = join(output, 'tree', f.room, temporary);
  expect(fs.readFileSync(first, 'utf8')).toBe(JSON.stringify(f.receipt));
  expect(fs.statSync(first).ino).toBe(fs.statSync(second).ino);
  expect(fs.statSync(first).nlink).toBe(2);
});
