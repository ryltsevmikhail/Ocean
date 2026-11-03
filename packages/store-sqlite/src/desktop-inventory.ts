import { ownerBusy } from './maintenance-owner.js';
import { DatabaseSync } from 'node:sqlite';
import {
  decodeDesktopAttachments,
  type DesktopAssetInventory,
  type DesktopBinding,
  type DesktopOperation,
} from '@runnets/domain';
/** Two-pass bounded SQLite evidence selection, no filesystem paths followed. */
export function desktopInventory(db: DatabaseSync, legacy = false): DesktopAssetInventory {
  const table = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const bindingSize = db
    .prepare(
      "SELECT length(CAST(value AS BLOB)) AS bytes FROM meta WHERE key='desktop_assets_binding'",
    )
    .get();
  if (Number(bindingSize?.['bytes'] ?? 0) > 16384) throw Error('desktop_inventory_limit');
  const raw = db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.[
    'value'
  ];
  const binding = raw ? (JSON.parse(String(raw)) as DesktopBinding) : null;
  const rooms = db
    .prepare('SELECT id FROM ocean_rooms ORDER BY id LIMIT 10001')
    .all()
    .map((r) => String(r['id']));
  if (rooms.length > 10000) throw Error('desktop_inventory_limit');
  const metadata = db
    .prepare(
      "SELECT id,length(CAST(body AS BLOB)) AS bytes FROM ocean_messages WHERE author='user' ORDER BY id LIMIT 10001",
    )
    .all();
  if (
    metadata.length > 10000 ||
    metadata.reduce((n, r) => n + Number(r['bytes']), 0) > 16777216 ||
    metadata.some((r) => Number(r['bytes']) > 65536)
  )
    throw Error('desktop_inventory_limit');
  const operations: DesktopOperation[] = [];
  if (table('ocean_desktop_operations')) {
    const sizes = db
      .prepare(
        'SELECT length(binding)+coalesce(length(result),0) AS bytes FROM ocean_desktop_operations LIMIT 10001',
      )
      .all();
    if (sizes.length > 10000 || sizes.reduce((n, r) => n + Number(r['bytes']), 0) > 16777216)
      throw Error('desktop_inventory_limit');
    for (const r of db.prepare('SELECT * FROM ocean_desktop_operations ORDER BY id').all())
      operations.push({
        id: String(r['id']),
        binding: String(r['binding']),
        state: r['state'] as DesktopOperation['state'],
        result: r['result'] === null ? null : String(r['result']),
      });
  }
  const messages: DesktopAssetInventory['messages'][number][] = [];
  let requestBytes = 0;
  for (const row of db
    .prepare(
      "SELECT id,room_id,workspace_id,body FROM ocean_messages WHERE author='user' ORDER BY id",
    )
    .all()) {
    const body = String(row['body']),
      decoded = decodeDesktopAttachments(body);
    if (!decoded) continue;
    const roomId = String(row['room_id']),
      id = String(row['id']);
    const evidence = db
      .prepare(
        'SELECT length(binding)+length(reply) AS bytes FROM ocean_receipts WHERE request_id=?',
      )
      .get(decoded.requestId);
    if (!evidence) {
      if (legacy) throw Error('desktop_request_unbound');
      continue; // An unbound post-enrollment marker remains inert text.
    }
    requestBytes += Number(evidence['bytes']);
    if (Number(evidence['bytes']) > 131072 || requestBytes > 16777216)
      throw Error('desktop_inventory_limit');
    const request = db
      .prepare('SELECT binding,reply FROM ocean_receipts WHERE request_id=?')
      .get(decoded.requestId)!;
    const requestBinding = String(request['binding']),
      requestReply = String(request['reply']);
    const input: unknown = JSON.parse(requestBinding),
      reply = JSON.parse(requestReply) as {
        kind?: string;
        data?: { id?: string; inboundMessageId?: string; roomId?: string; workspaceId?: string };
      };
    if (
      !Array.isArray(input) ||
      input[0] !== 'SendDirect' ||
      input[1] !== row['workspace_id'] ||
      input[2] !== roomId ||
      input[3] !== body ||
      reply.data?.roomId !== roomId ||
      reply.data.workspaceId !== row['workspace_id'] ||
      (reply.kind === 'message'
        ? reply.data.id
        : reply.kind === 'turn'
          ? reply.data.inboundMessageId
          : null) !== id
    )
      continue;

    const adopted =
      table('ocean_desktop_adopted') &&
      db
        .prepare(
          'SELECT 1 FROM ocean_desktop_adopted WHERE message_id=? AND room=? AND request_id=? AND body=?',
        )
        .get(id, roomId, decoded.requestId, body);
    const op = operations.find(
      (o) => o.id === 'prepare:' + roomId + ':' + decoded.requestId && o.state === 'completed',
    );
    if (
      legacy ||
      adopted ||
      (op && (JSON.parse(String(op.result)) as { prepared?: string }).prepared === body)
    )
      messages.push({
        id,
        roomId,
        requestId: decoded.requestId,
        body,
        requestBinding,
        requestReply,
      });
  }
  const uploads: DesktopAssetInventory['uploads'][number][] = [];
  if (table('ocean_desktop_uploads')) {
    const query =
      "FROM ocean_desktop_uploads u WHERE NOT EXISTS(SELECT 1 FROM ocean_desktop_operations o WHERE o.id='upload:'||u.id AND o.state='completed')";
    const metadata = db
      .prepare('SELECT length(CAST(data AS BLOB)) AS bytes ' + query + ' LIMIT 10001')
      .all();
    if (metadata.length > 10000 || metadata.reduce((n, r) => n + Number(r['bytes']), 0) > 16777216)
      throw Error('desktop_inventory_limit');
    for (const r of db.prepare('SELECT * ' + query + ' ORDER BY id').all())
      uploads.push({
        id: String(r['id']),
        room: String(r['room']),
        name: String(r['name']),
        bytes: Number(r['size']),
        sha256: String(r['sha256']),
        data: String(r['data']),
      });
  }
  const inventory = { format: 1 as const, binding, rooms, messages, operations, uploads };
  if (Buffer.byteLength(JSON.stringify(inventory)) > 16777216)
    throw Error('desktop_inventory_limit');
  return inventory;
}
export function readDesktopBackupInventory(path: string): DesktopAssetInventory {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (ownerBusy(db)) throw Error('owner_busy');
    return desktopInventory(db);
  } finally {
    db.close();
  }
}
