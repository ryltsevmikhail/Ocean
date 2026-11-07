import { expect, it } from 'vitest';
import type { RoomTaskRootView } from '@runnets/contracts';
import { outputs } from '../protocol.js';
import { runText } from './runtime-text.js';
it('preserves actual final result and does not call historical unknown or yielded completion an answer', () => {
  const base = {
    turnId: 't',
    messageId: 'm',
    roomId: 'r',
    runId: 'run',
    version: 1,
    performerId: 'b',
    turnStatus: 'completed' as const,
    taskStatus: 'completed',
    pendingDecisionIds: [],
  };
  const runs = outputs.runs.parse([
    { ...base, resultMessageId: 'result' },
    { ...base, resultMessageId: null },
    base,
  ]);
  expect(runs[0]).toHaveProperty('resultMessageId', 'result');
  expect(runText(runs[0]!, 'b')).toBe('@b ответил');
  expect(runText(runs[1]!, 'b')).not.toMatch(/ответил/i);
  expect(runText(runs[2]!, 'b')).not.toMatch(/ответил/i);
});
it('distinguishes addressed peer messages, yielded slices, peer waits and unknown fences from actual answers', async () => {
  const { addressedTarget, taskRowText } = await import('./room-task-text.js');
  expect(addressedTarget('a', 'b')).toBe('b');
  expect(addressedTarget('a', 'a')).toBeNull();
  const parent = {
    type: 'task' as const,
    id: 'parent',
    botId: 'a',
    parentId: null,
    status: 'waiting' as const,
    waitingChildId: 'child',
    hold: 'waiting' as const,
  };
  const child = { ...parent, id: 'child', botId: 'b', waitingChildId: null };
  const v = { rows: [parent, child] } as unknown as RoomTaskRootView;
  expect(taskRowText(parent, v, (id) => '@' + id)).toContain('ждёт @b');
  const slice = {
    type: 'slice' as const,
    taskId: 'parent',
    deliveryId: 'd',
    runId: 'run',
    turnId: 't',
    turnStatus: 'completed',
    taskStatus: 'succeeded',
    version: 1,
    disposition: 'yielded' as const,
    resultMessageId: null,
    pendingDecisionIds: [],
    hold: 'unknown' as const,
  };
  expect(taskRowText(slice, v, (id) => id)).toContain('передал ход, итогового ответа нет');
  expect(taskRowText(slice, v, (id) => id)).toContain('unknown');
  expect(
    taskRowText({ ...slice, disposition: null, resultMessageId: 'reply' }, v, (id) => id),
  ).toContain('ответ: reply');
});
