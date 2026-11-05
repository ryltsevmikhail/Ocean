import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import { activeWitness, publicReceipt, receiptOwner } from './model-process-witness.ts';
/** Fixture-only interposition. IDs are correlated independently on each incoming socket. */
export function dropper(profile: string, record: (phase: string) => void) {
  let target: { method: string; requestId: string; connectionId: string } | null = null;
  const correlations = new WeakMap<Socket, Map<string, { method: string; requestId?: string }>>();
  const buffers = new WeakMap<Socket, string>();
  const emit = Socket.prototype.emit;
  Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === 'data' && Buffer.isBuffer(args[0])) {
      let buffer = (buffers.get(this) ?? '') + args[0].toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end)) as {
          id: string;
          method: string;
          params?: { requestId?: string };
        };
        const map = correlations.get(this) ?? new Map();
        map.set(frame.id, { method: frame.method, requestId: frame.params?.requestId });
        correlations.set(this, map);
        buffer = buffer.slice(end + 1);
      }
      buffers.set(this, buffer);
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  };
  const write = Socket.prototype.write;
  Socket.prototype.write = function (this: Socket, ...args: Parameters<Socket['write']>) {
    const chunk = args[0];
    if (target && (Buffer.isBuffer(chunk) || typeof chunk === 'string')) {
      const frame = JSON.parse(chunk.toString()) as { id: string; result?: unknown };
      const incoming = correlations.get(this)?.get(frame.id);
      if (
        incoming?.method === target.method &&
        incoming.requestId === target.requestId &&
        'result' in frame
      ) {
        assert.ok(frame.result);
        const owner = receiptOwner(target.method, target.connectionId);
        const committed = activeWitness(profile, target.requestId, owner);
        assert.equal(
          JSON.stringify(frame.result) === JSON.stringify(publicReceipt(committed, owner)),
          true,
          'suppressed public result differs from original persisted result',
        );
        // Preserve only the actual outbound public DTO before closing, once per private rig.
        writeFileSync(profile + '/suppressed-public-result.json', JSON.stringify(frame.result), {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
        target = null;
        record('reply-suppressed-after-active-receipt');
        this.destroy();
        return false;
      }
    }
    return write.apply(this, args);
  } as Socket['write'];
  return (input: { method: string; requestId: string; connectionId: string }) => {
    target = input;
  };
}
