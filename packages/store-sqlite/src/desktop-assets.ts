import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { DesktopAssetStore } from '@runnets/application';
import {
  DESKTOP_CHUNK_BYTES,
  DESKTOP_FILE_BYTES,
  type DesktopBinding,
  type DesktopOperation,
  type DesktopPreparation,
} from '@runnets/domain';
import { desktopInventory } from './desktop-inventory.js';
export function desktopAssetStore(db: DatabaseSync): DesktopAssetStore {
  const get = (id: string) => db.prepare('SELECT * FROM ocean_desktop_uploads WHERE id=?').get(id);
  return {
    binding() {
      const raw = db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.[
        'value'
      ];
      return raw ? (JSON.parse(String(raw)) as DesktopBinding) : null;
    },
    inventory: (legacy) => desktopInventory(db, legacy),
    room(room) {
      if (!db.prepare('SELECT 1 FROM ocean_rooms WHERE id=?').get(room))
        throw Error('unknown_room');
    },
    operation(id) {
      const r = db.prepare('SELECT * FROM ocean_desktop_operations WHERE id=?').get(id);
      return r
        ? {
            id,
            binding: String(r['binding']),
            state: r['state'] as DesktopOperation['state'],
            result: r['result'] === null ? null : String(r['result']),
          }
        : null;
    },
    start(id, binding) {
      db.prepare("INSERT INTO ocean_desktop_operations VALUES(?,?,'started',NULL)").run(
        id,
        binding,
      );
    },
    complete(id, result, binding, adopted, preparations) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (binding)
          db.prepare("INSERT INTO meta VALUES('desktop_assets_binding',?)").run(
            JSON.stringify(binding),
          );
        for (const m of adopted ?? [])
          db.prepare('INSERT INTO ocean_desktop_adopted VALUES(?,?,?,?)').run(
            m.id,
            m.roomId,
            m.requestId,
            m.body,
          );
        for (const p of preparations ?? [])
          db.prepare(
            "INSERT OR IGNORE INTO ocean_desktop_operations VALUES(?,?,'completed',?)",
          ).run(
            'prepare:' + p.room + ':' + p.requestId,
            JSON.stringify({
              room: p.room,
              requestId: p.requestId,
              body: p.receipt.body,
              to: p.receipt.to,
              ids: p.receipt.ids,
            }),
            JSON.stringify(p.receipt),
          );
        db.prepare(
          "UPDATE ocean_desktop_operations SET state='completed',result=? WHERE id=? AND state='started'",
        ).run(result, id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    upload(id, room, name, size, sha256) {
      const old = get(id);
      if (old) {
        if (
          old['room'] !== room ||
          old['name'] !== name ||
          old['size'] !== size ||
          old['sha256'] !== sha256
        )
          throw Error('request_conflict');
        return;
      }
      const usage = db
        .prepare('SELECT count(*) AS n,coalesce(sum(size),0) AS bytes FROM ocean_desktop_uploads')
        .get()!;
      if (
        Number(usage['n']) >= 10000 ||
        Number(usage['bytes']) + size > 134217728 ||
        size > DESKTOP_FILE_BYTES
      )
        throw Error('desktop_upload_limit');
      db.prepare("INSERT INTO ocean_desktop_uploads VALUES(?,?,?,?,?,'')").run(
        id,
        room,
        name,
        size,
        sha256,
      );
    },
    chunk(id, offset, data) {
      const old = get(id);
      if (!old) throw Error('unknown_upload');
      if (
        db
          .prepare("SELECT 1 FROM ocean_desktop_operations WHERE id=? AND state='started'")
          .get('upload:' + id)
      )
        throw Error('desktop_outcome_unknown');
      const chunk = Buffer.from(data, 'base64'),
        prior = Buffer.from(String(old['data']), 'base64');
      if (
        chunk.toString('base64') !== data ||
        chunk.length > DESKTOP_CHUNK_BYTES ||
        offset < 0 ||
        offset + chunk.length > Number(old['size'])
      )
        throw Error('invalid_params');
      if (offset < prior.length) {
        if (!prior.subarray(offset, offset + chunk.length).equals(chunk))
          throw Error('request_conflict');
        return prior.length;
      }
      if (offset !== prior.length) throw Error('upload_offset');
      const next = Buffer.concat([prior, chunk]);
      db.prepare('UPDATE ocean_desktop_uploads SET data=? WHERE id=?').run(
        next.toString('base64'),
        id,
      );
      return next.length;
    },
    uploaded(id) {
      const r = get(id);
      if (!r) throw Error('unknown_upload');
      const data = String(r['data']),
        bytes = Buffer.from(data, 'base64');
      if (
        bytes.length !== r['size'] ||
        createHash('sha256').update(bytes).digest('hex') !== r['sha256']
      )
        throw Error('upload_incomplete');
      return {
        room: String(r['room']),
        name: String(r['name']),
        size: Number(r['size']),
        sha256: String(r['sha256']),
        data,
      };
    },
    associated(room, requestId, messageId, prepared) {
      const message = db
        .prepare(
          "SELECT workspace_id FROM ocean_messages WHERE id=? AND room_id=? AND author='user' AND body=?",
        )
        .get(messageId, room, prepared);
      const size = db
        .prepare('SELECT length(binding)+length(reply) AS n FROM ocean_receipts WHERE request_id=?')
        .get(requestId);
      if (!message || !size || Number(size['n']) > 131072) return false;
      const row = db
        .prepare('SELECT binding,reply FROM ocean_receipts WHERE request_id=?')
        .get(requestId)!;
      const binding: unknown = JSON.parse(String(row['binding']));
      const reply = JSON.parse(String(row['reply'])) as {
        kind?: string;
        data?: { id?: string; inboundMessageId?: string; roomId?: string; workspaceId?: string };
      };
      return (
        Array.isArray(binding) &&
        // Broadcast user messages are legitimately target-less but share the same proof shape.
        (binding[0] === 'SendDirect' || binding[0] === 'Broadcast') &&
        binding[1] === message['workspace_id'] &&
        binding[2] === room &&
        binding[3] === prepared &&
        reply.data?.roomId === room &&
        reply.data.workspaceId === message['workspace_id'] &&
        (reply.kind === 'message'
          ? reply.data.id
          : reply.kind === 'turn'
            ? reply.data.inboundMessageId
            : null) === messageId
      );
    },
    prepared(room, requestId) {
      const r = db
        .prepare("SELECT result FROM ocean_desktop_operations WHERE id=? AND state='completed'")
        .get('prepare:' + room + ':' + requestId);
      return r ? (JSON.parse(String(r['result'])) as DesktopPreparation) : null;
    },
    message(room, messageId) {
      const r = db
        .prepare("SELECT body FROM ocean_messages WHERE id=? AND room_id=? AND author='user'")
        .get(messageId, room);
      return r === undefined ? null : { body: String(r['body']) };
    },
    adopted(room, requestId, messageId, body) {
      return (
        db
          .prepare(
            'SELECT 1 FROM ocean_desktop_adopted WHERE message_id=? AND room=? AND request_id=? AND body=?',
          )
          .get(messageId, room, requestId, body) !== undefined
      );
    },
  };
}
