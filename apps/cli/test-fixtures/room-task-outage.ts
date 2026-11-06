import type { HttpClient } from '@runnets/provider-core';
import type { RoomTaskMemberPin } from '@runnets/application';
import type { ChatTurn } from '@runnets/domain';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
export function roomTaskOutageHttp(base: HttpClient, failed: 'cloud' | 'local') {
  const attempts: { provider: 'cloud' | 'local'; model: string }[] = [];
  const http: HttpClient = {
    async send(request) {
      const provider = request.url.endsWith('/api/chat')
        ? 'local'
        : request.url.endsWith('/chat/completions')
          ? 'cloud'
          : null;
      if (provider) {
        const body = JSON.parse(request.body!) as { model: string };
        attempts.push({ provider, model: body.model });
        if (provider === failed)
          return {
            ok: false,
            status: 503,
            text: async () => '{"error":"synthetic outage"}',
            async *stream() {},
          };
      }
      return base.send(request);
    },
  };
  return { http, attempts };
}
export function roomTaskOutageEvidence(profile: string, rootId: string) {
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  try {
    const root = db.prepare('SELECT root_payload FROM ocean_room_tasks WHERE id=?').get(rootId)!;
    return {
      pins: (JSON.parse(String(root['root_payload'])) as { members: RoomTaskMemberPin[] }).members,
      turns: db
        .prepare(
          `SELECT c.payload FROM ocean_chat_turns c JOIN ocean_room_tasks t ON t.id=json_extract(c.payload,'$.roomDelivery.taskId') WHERE t.root_id=? ORDER BY c.rowid`,
        )
        .all(rootId)
        .map((r) => JSON.parse(String(r['payload'])) as ChatTurn),
    };
  } finally {
    db.close();
  }
}
