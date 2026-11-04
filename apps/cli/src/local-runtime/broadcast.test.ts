import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  broadcastProfile,
  settledBatch,
  startBroadcastHost,
} from '../../test-fixtures/broadcast-host.test.js';
import { vendorFixture, type VendorFixture } from '../../test-fixtures/local-provider-host.test.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const vendor = await vendorFixture();
  const profile = await broadcastProfile();
  const started = await startBroadcastHost(profile, vendor.url);
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  return { vendor, profile, started };
}
async function until(condition: () => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('timeout: ' + label);
    await sleep(20);
  }
}
function chat(vendor: VendorFixture) {
  return vendor.requests.filter((request) => request.url === '/chat/completions');
}
it('broadcasts exactly one user message and one answer per participant with frozen contexts', async () => {
  const { vendor, profile, started } = await fixture();
  const requestId = 'broadcast-1';
  const submitted = await started.client.broadcastSubmit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId,
    text: 'Вопрос обоим участникам',
  });
  expect(submitted.recipients.map((child) => child.position)).toEqual([0, 1]);
  const settled = await settledBatch(started.client, profile, submitted.id);
  expect(settled.state).toBe('completed');
  expect(settled.recipients.map((child) => child.state)).toEqual(['answered', 'answered']);
  expect(settled.recipients.every((child) => child.resultMessageId !== null)).toBe(true);
  // Exactly two provider requests, one per participant, and no follow-up round.
  expect(chat(vendor)).toHaveLength(2);
  const bodies = chat(vendor).map((request) => JSON.parse(request.body) as Record<string, unknown>);
  for (const body of bodies) {
    const messages = body['messages'] as { role: string; content: string }[];
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Вопрос обоим участникам' });
    expect(Object.hasOwn(body, 'tools')).toBe(false);
  }
  // The second child's request cannot contain the first child's answer.
  const firstAnswer = 'fixture answer';
  expect(bodies[1] ? JSON.stringify(bodies[1]) : '').not.toContain('Ответ ' + profile.botIds[0]);
  const historyReply = await started.client.history({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    after: 0,
    limit: 50,
  });
  expect(historyReply.filter((message) => message.author === 'user')).toHaveLength(1);
  expect(historyReply.filter((message) => message.author === 'bot')).toHaveLength(2);
  expect(
    new Set(historyReply.filter((m) => m.author === 'bot').map((m) => m.authorBotId)).size,
  ).toBe(2);
  // A lost reply recovers the same durable batch through the request id.
  expect(
    await started.client.broadcastGet({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId,
    }),
  ).toMatchObject({ id: submitted.id, messageId: submitted.messageId });
  // Identical retry returns the original batch identity; changed data conflicts.
  expect(
    await started.client.broadcastSubmit({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId,
      text: 'Вопрос обоим участникам',
    }),
  ).toMatchObject({ id: submitted.id, messageId: submitted.messageId });
  await expect(
    started.client.broadcastSubmit({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId,
      text: 'Изменённый вопрос',
    }),
  ).rejects.toThrow('request_conflict');
  expect(chat(vendor)).toHaveLength(2);
  expect(firstAnswer.length).toBeGreaterThan(0);
});
it('refuses new model turns while a batch holds the room but keeps notes available', async () => {
  const { vendor, profile, started } = await fixture();
  vendor.hold();
  const submitted = await started.client.broadcastSubmit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'broadcast-hold',
    text: 'Вопрос всем',
  });
  await until(() => chat(vendor).length === 1, 'first child in flight');
  await expect(
    started.client.submit({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId: 'turn-during-batch',
      text: 'Новый вопрос',
      to: 'dev',
    }),
  ).rejects.toThrow('batch_open');
  // Notes are not model turns and stay available while the batch holds the room.
  const note = await started.client.submit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'note-1',
    text: 'Заметка без модели',
  });
  expect(note.runId).toBeNull();
  vendor.release();
  const settled = await settledBatch(started.client, profile, submitted.id);
  expect(settled.state).toBe('completed');
  const again = await started.client.submit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'turn-after',
    text: 'После рассылки',
    to: 'dev',
  });
  expect(again.runId).not.toBeNull();
  await until(() => chat(vendor).length === 3, 'turn after broadcast dispatched');
});
it('never grants coding tools to broadcast children', async () => {
  const { vendor, profile, started } = await fixture();
  const submitted = await started.client.broadcastSubmit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'broadcast-tools',
    text: 'Вопрос без инструментов',
  });
  await settledBatch(started.client, profile, submitted.id);
  const bodies = chat(vendor).map((request) => request.body);
  expect(bodies).toHaveLength(2);
  for (const body of bodies) expect(body).not.toContain('tools');
  // No child turn carries a coding task or review binding.
  const hash = createHash('sha256').update(profile.profile).digest('hex');
  expect(hash).toHaveLength(64);
});

it('keeps existing per-child cancellation semantics and never claims remote stop', async () => {
  const { vendor, profile, started } = await fixture();
  vendor.hold();
  const submitted = await started.client.broadcastSubmit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'broadcast-cancel',
    text: 'Вопрос с отменой',
  });
  await until(() => chat(vendor).length === 1, 'first child in flight');
  const runs = await started.client.listRuns({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    limit: 50,
  });
  const active = runs.find(
    (run) => run.turnStatus === 'dispatching' || run.turnStatus === 'accepted',
  );
  if (!active) throw Error('active child');
  // A queued sibling cannot be "confirmed cancelled": it was never dispatched.
  const queued = runs.find((run) => run.turnStatus === 'queued');
  if (queued) {
    await expect(
      started.client.cancelRun({
        workspaceId: 'ws_ocean',
        roomId: profile.roomId,
        runId: queued.runId,
        expectedVersion: queued.version,
        requestId: 'cancel-queued',
      }),
    ).rejects.toThrow(/run_not_active|cannot_request_cancel/);
  }
  const cancelled = await started.client.cancelRun({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    runId: active.runId,
    expectedVersion: active.version,
    requestId: 'cancel-active',
  });
  expect(cancelled.status).toBe('requested');
  vendor.release();
  const settled = await settledBatch(started.client, profile, submitted.id);
  // A started child with an unknown outcome pauses the batch; no fabricated answer is published.
  expect(settled.state).toBe('paused');
  const first = settled.recipients[0];
  expect(first?.state).toBe('uncertain');
  expect(first?.resultMessageId).toBeNull();
  expect(settled.recipients[1]?.state).toBe('queued');
  await expect(
    started.client.broadcastContinue({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      batchId: submitted.id,
      expectedRevision: settled.revision,
    }),
  ).rejects.toThrow('batch_uncertain');
  const abandoned = await started.client.broadcastAbandon({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    batchId: submitted.id,
    expectedRevision: settled.revision,
  });
  expect(abandoned.recipients.map((child) => child.state)).toEqual(['uncertain', 'not_started']);
});

it('refuses only the child whose model the active provider cannot serve', async () => {
  const vendor = await vendorFixture();
  const profile = await broadcastProfile(['deepseek-flash', 'deepseek-v4-pro']);
  let calls = 0;
  const provider = {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream() {
      calls += 1;
      yield { type: 'text_delta', text: 'только flash' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  } as const;
  const started = await startBroadcastHost(profile, vendor.url, provider);
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  const submitted = await started.client.broadcastSubmit({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    requestId: 'broadcast-refusal',
    text: 'Вопрос двоим',
  });
  const settled = await settledBatch(started.client, profile, submitted.id);
  expect(settled.state).toBe('completed');
  const states = Object.fromEntries(settled.recipients.map((child) => [child.handle, child.state]));
  expect(states).toEqual({ dev: 'answered', review: 'refused' });
  expect(settled.recipients.find((child) => child.handle === 'review')?.resultMessageId).toBeNull();
  expect(calls).toBe(1);
});
it('rejects a wrong room without any provider request', async () => {
  const vendor = await vendorFixture();
  const profile = await broadcastProfile();
  const started = await startBroadcastHost(profile, vendor.url);
  cleanups.push(async () => {
    await started.stop();
    await vendor.close();
    profile.dispose();
  });
  await expect(
    started.client.broadcastSubmit({
      workspaceId: 'ws_ocean',
      roomId: 'unknown-room',
      requestId: 'broadcast-wrong-room',
      text: 'Вопрос',
    }),
  ).rejects.toThrow('unknown_room');
  expect(vendor.requests).toHaveLength(0);
});
