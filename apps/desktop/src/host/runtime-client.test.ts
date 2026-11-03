import { describe, expect, it } from 'vitest';
import { commands, outputs } from '../protocol.js';

describe('renderer and host contract', () => {
  it('refuses profile initialization and cancellation without the displayed run/version', () => {
    expect(commands.safeParse({ op: 'init' }).success).toBe(false);
    expect(commands.safeParse({ op: 'cancel', requestId: crypto.randomUUID() }).success).toBe(
      false,
    );
    expect(
      commands.safeParse({
        op: 'cancel',
        room: 'room_a',
        runId: 'tr_a',
        expectedVersion: 3,
        requestId: crypto.randomUUID(),
      }).success,
    ).toBe(true);
  });
  it('only accepts a complete durable identity as the send acknowledgement', () => {
    expect(outputs.send.safeParse({ status: 'completed' }).success).toBe(false);
    expect(
      outputs.send.safeParse({
        workspaceId: 'ws_ocean',
        roomId: 'room_a',
        requestId: crypto.randomUUID(),
        messageId: 'msg_a',
        turnId: 'turn_a',
        runId: 'tr_a',
      }).success,
    ).toBe(true);
  });
});
