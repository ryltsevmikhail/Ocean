import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export function dropTurn(profile: string) {
  let target: string | null = null;
  const write = Socket.prototype.write;
  Socket.prototype.write = function (this: Socket, ...args: Parameters<Socket['write']>) {
    if (target && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))) {
      const frame = JSON.parse(args[0].toString()) as { result?: { runId?: string } };
      if (frame.result?.runId) {
        const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
        try {
          const row = db
            .prepare('SELECT reply FROM ocean_receipts WHERE request_id=?')
            .get(target)!;
          const receipt = JSON.parse(String(row['reply'])) as { data: { taskRunId: string } };
          assert.equal(
            receipt.data.taskRunId,
            frame.result.runId,
            'receipt must commit before lost reply',
          );
        } finally {
          db.close();
        }
        writeFileSync(profile + '/lost-turn.json', JSON.stringify(frame.result), {
          mode: 0o600,
          flush: true,
        });
        target = null;
        this.destroy();
        return false;
      }
    }
    return write.apply(this, args);
  } as Socket['write'];
  return (requestId: string) => {
    target = requestId;
  };
}
