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

it('only reads a receipt by its fixed-workspace room and UUID, without accepting a proposed binding', () => {
  const ref = { op: 'receipt', room: 'room_a', requestId: crypto.randomUUID() };
  expect(commands.safeParse(ref).success).toBe(true);
  for (const change of [
    { text: 'changed' },
    { to: 'other' },
    { workspaceId: 'elsewhere' },
    { attachments: [] },
  ])
    expect(commands.safeParse({ ...ref, ...change }).success).toBe(false);
});

describe('provider settings IPC contract', () => {
  const status = {
    provider: 'deepseek',
    source: 'saved',
    state: 'connected',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelCapabilities: [
      { model: 'deepseek-flash', imageInput: true },
      { model: 'deepseek-v4-pro', imageInput: false },
    ],
    revision: 4,
    savedKey: true,
    writable: true,
    code: null,
    lastCheck: null,
  };
  it('accepts bounded owner commands and refuses a malformed revision guard', () => {
    const requestId = crypto.randomUUID();
    expect(commands.safeParse({ op: 'provider' }).success).toBe(true);
    expect(commands.safeParse({ op: 'provider-check' }).success).toBe(true);
    expect(
      commands.safeParse({ op: 'provider-set', requestId, model: 'deepseek-flash' }).success,
    ).toBe(true);
    expect(
      commands.safeParse({ op: 'provider-set', requestId, key: 'sk-key', model: 'deepseek-flash' })
        .success,
    ).toBe(true);
    expect(
      commands.safeParse({ op: 'provider-set', requestId, key: 'x'.repeat(513), model: 'm' })
        .success,
    ).toBe(false);
    expect(
      commands.safeParse({ op: 'provider-set', requestId, key: '', model: 'deepseek-flash' })
        .success,
    ).toBe(false);
    expect(
      commands.safeParse({ op: 'provider-disconnect', requestId, expectedRevision: 2 }).success,
    ).toBe(true);
    expect(
      commands.safeParse({ op: 'provider-disconnect', requestId, expectedRevision: -1 }).success,
    ).toBe(false);
    expect(commands.safeParse({ op: 'provider-remove-key', requestId }).success).toBe(false);
  });
  it('accepts only metadata-only provider replies', () => {
    expect(outputs.provider.safeParse(status).success).toBe(true);
    expect(outputs.provider.safeParse({ ...status, key: 'sk-leak' }).success).toBe(false);
    expect(outputs.provider.safeParse({ ...status, source: 'env' }).success).toBe(false);
    expect(outputs['provider-set'].safeParse(status).success).toBe(true);
    expect(
      outputs['provider-check'].safeParse({
        status,
        check: {
          outcome: 'ok',
          httpStatus: 200,
          durationMs: 5,
          models: ['deepseek-flash'],
          modelSupported: true,
          source: 'saved',
          revision: 4,
          checkedAt: '2026-11-04T00:00:00.000Z',
          persisted: true,
        },
      }).success,
    ).toBe(true);
    expect(
      outputs['provider-check'].safeParse({ status, check: { outcome: 'ok', persisted: true } })
        .success,
    ).toBe(false);
  });
});
