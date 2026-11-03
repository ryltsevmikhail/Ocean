import {
  desktopPreparationAliases,
  checkDesktopAliasReceipt,
} from './desktop-preparation-alias.js';
import { createHash } from 'node:crypto';
import {
  decodeDesktopAttachments,
  desktopRoom,
  desktopUuid,
  validDesktopAttachment,
  type DesktopPreparation,
  type DesktopAttachment,
  type DesktopAssetInventory,
  type CodingAssetManifest,
} from '@runnets/domain';
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
/** All callers first validate the complete metadata set and byte budget. */
export function checkDesktopEvidence(
  inventory: DesktopAssetInventory,
  manifest: CodingAssetManifest,
  read: (path: string) => Buffer,
) {
  const bad = (): never => {
    throw Error('desktop_asset_corrupted');
  };
  if (
    inventory.format !== 1 ||
    !inventory.binding ||
    !Array.isArray(inventory.rooms) ||
    inventory.rooms.length > 10000 ||
    !inventory.rooms.every(desktopRoom) ||
    !Array.isArray(inventory.messages) ||
    inventory.messages.length > 10000 ||
    !Array.isArray(inventory.operations) ||
    inventory.operations.length > 10000 ||
    Buffer.byteLength(JSON.stringify(inventory)) > 16777216
  )
    bad();
  for (const operation of inventory.operations) {
    if (
      !operation ||
      typeof operation.id !== 'string' ||
      operation.id.length > 300 ||
      typeof operation.binding !== 'string' ||
      operation.binding.length > 131072 ||
      !['started', 'completed'].includes(operation.state) ||
      (operation.result !== null &&
        (typeof operation.result !== 'string' || operation.result.length > 131072)) ||
      (operation.state === 'completed' && operation.result === null)
    )
      bad();
  }
  const binding = inventory.binding!;
  if (
    typeof binding.profileId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(binding.profileId) ||
    typeof binding.identity !== 'string' ||
    !/^\d+(?::\d+){5}$/.test(binding.identity) ||
    [binding.root, binding.originalRoot].some(
      (p) =>
        typeof p !== 'string' ||
        p.length > 4096 ||
        !p.startsWith('/') ||
        p.includes('\0') ||
        p.split('/').some((part) => part === '.' || part === '..'),
    )
  )
    bad();
  if (!Array.isArray(inventory.uploads) || inventory.uploads.length > 10000) bad();
  for (const upload of inventory.uploads) {
    if (
      !desktopUuid(upload.id) ||
      !inventory.rooms.includes(upload.room) ||
      typeof upload.name !== 'string' ||
      upload.name.length > 180 ||
      !Number.isSafeInteger(upload.bytes) ||
      upload.bytes < 0 ||
      upload.bytes > 10485760 ||
      typeof upload.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(upload.sha256) ||
      typeof upload.data !== 'string' ||
      upload.data.length > 13981016
    )
      bad();
    const data = Buffer.from(upload.data, 'base64');
    if (
      data.toString('base64') !== upload.data ||
      data.length > upload.bytes ||
      (data.length === upload.bytes && hash(data) !== upload.sha256)
    )
      bad();
  }
  const aliases = desktopPreparationAliases(inventory, manifest);
  const entries = new Map(manifest.entries.map((e) => [e.path, e]));
  const bytes = (path: string) => {
    const entry = entries.get(path);
    if (!entry || entry.kind !== 'file') return bad();
    const data = read(path);
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) return bad();
    return data;
  };
  const parse = (path: string): unknown => {
    try {
      return JSON.parse(bytes(path).toString('utf8'));
    } catch {
      return bad();
    }
  };
  const attachment = (room: string, id: string) => {
    const value = parse(room + '/' + id + '/metadata.json');
    if (!validDesktopAttachment(value) || value.id !== id) return bad();
    const blob = entries.get(room + '/' + id + '/blob');
    if (!blob || blob.kind !== 'file' || blob.sha256 !== value.sha256 || blob.bytes !== value.bytes)
      return bad();
    return value;
  };
  const preparation = (room: string, requestId: string): DesktopPreparation => {
    const value = parse(room + '/' + requestId + '.json') as DesktopPreparation;
    if (
      !value ||
      typeof value.body !== 'string' ||
      typeof value.prepared !== 'string' ||
      value.prepared.length > 16384 ||
      hash(value.prepared) !== value.digest ||
      !Array.isArray(value.ids) ||
      value.ids.length < 1 ||
      value.ids.length > 4 ||
      new Set(value.ids).size !== value.ids.length ||
      !value.ids.every(desktopUuid) ||
      (value.to !== null && typeof value.to !== 'string')
    )
      return bad();
    const decoded = decodeDesktopAttachments(value.prepared);
    if (
      !decoded ||
      decoded.requestId !== requestId ||
      JSON.stringify(decoded.files.map((f) => f.id)) !== JSON.stringify(value.ids)
    )
      return bad();
    for (const info of decoded.files) {
      const saved = attachment(room, info.id);
      if (
        (['id', 'name', 'bytes', 'sha256', 'kind', 'mime'] as const).some(
          (key) => saved[key] !== info[key],
        )
      )
        return bad();
    }
    if (aliases.has(room + '/' + requestId + '.json'))
      checkDesktopAliasReceipt(inventory, room, requestId, value);
    return value;
  };
  const preparations: { room: string; requestId: string; receipt: DesktopPreparation }[] = [];
  for (const entry of manifest.entries) {
    const [room, name, leaf] = entry.path.split('/');
    if (room && !inventory.rooms.includes(room)) bad();
    if (desktopUuid(name) && leaf === 'metadata.json') attachment(room!, name);
    if (name?.endsWith('.json') && desktopUuid(name.slice(0, -5)) && !leaf)
      preparations.push({
        room: room!,
        requestId: name.slice(0, -5),
        receipt: preparation(room!, name.slice(0, -5)),
      });
  }
  for (const operation of inventory.operations) {
    if (operation.state !== 'completed') continue;
    if (operation.id.startsWith('prepare:')) {
      const [, room, requestId] = operation.id.split(':');
      if (!desktopRoom(room) || !desktopUuid(requestId)) bad();
      const receipt = preparation(room!, requestId!),
        stored = JSON.parse(operation.result!) as DesktopPreparation;
      const input = JSON.parse(operation.binding) as {
        room?: string;
        requestId?: string;
        body?: string;
        to?: string | null;
        ids?: string[];
      };
      if (
        !stored ||
        !input ||
        input.room !== room ||
        input.requestId !== requestId ||
        input.body !== receipt.body ||
        input.to !== receipt.to ||
        JSON.stringify(input.ids) !== JSON.stringify(receipt.ids) ||
        (['digest', 'body', 'to', 'prepared'] as const).some(
          (key) => stored[key] !== receipt[key],
        ) ||
        JSON.stringify(stored.ids) !== JSON.stringify(receipt.ids)
      )
        bad();
    } else if (operation.id.startsWith('upload:')) {
      const info: unknown = JSON.parse(operation.result!),
        input = JSON.parse(operation.binding) as { room?: string; size?: number; sha256?: string };
      if (!validDesktopAttachment(info) || !input || !desktopRoom(input.room)) bad();
      const saved = attachment(input.room!, (info as DesktopAttachment).id);
      if (
        saved.bytes !== input.size ||
        saved.sha256 !== input.sha256 ||
        (['id', 'name', 'bytes', 'sha256', 'kind', 'mime'] as const).some(
          (key) => saved[key] !== (info as DesktopAttachment)[key],
        )
      )
        bad();
    }
  }
  for (const message of inventory.messages) {
    if (
      !desktopRoom(message.roomId) ||
      !desktopUuid(message.requestId) ||
      typeof message.body !== 'string' ||
      message.body.length > 16384
    )
      bad();
    const receipt = preparation(message.roomId, message.requestId);
    if (
      receipt.prepared !== message.body ||
      typeof message.requestBinding !== 'string' ||
      typeof message.requestReply !== 'string'
    )
      bad();
    const input: unknown = JSON.parse(message.requestBinding),
      reply = JSON.parse(message.requestReply) as {
        kind?: string;
        data?: { id?: string; inboundMessageId?: string; roomId?: string; workspaceId?: string };
      };
    if (
      !Array.isArray(input) ||
      input[0] !== 'SendDirect' ||
      input[2] !== message.roomId ||
      input[3] !== message.body ||
      (input[4] ?? null) !== receipt.to ||
      reply.data?.roomId !== message.roomId ||
      reply.data.workspaceId !== input[1] ||
      (reply.kind === 'message'
        ? reply.data.id
        : reply.kind === 'turn'
          ? reply.data.inboundMessageId
          : null) !== message.id
    )
      bad();
  }
  return preparations;
}
