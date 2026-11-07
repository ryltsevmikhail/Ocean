import { expect, it } from 'vitest';
import {
  decideRoomAddress,
  canonicalJson,
  type RoomDeliveryOrigin,
  type RoomTaskAddress,
} from './index.js';

const task = (): RoomTaskAddress => ({
  id: 'task-a',
  workspaceId: 'ws',
  roomId: 'room',
  rootId: 'root',
  parentId: 'root',
  assigneeBotId: 'a',
  members: ['a', 'b', 'c'],
  grantReferences: [],
  status: 'ready',
  lastDeliverySeq: 0,
});
const origin = (): RoomDeliveryOrigin => ({
  task: task(),
  botId: 'a',
  turnId: 'turn',
  deliveryId: 'delivery',
  attemptId: 'attempt',
  callId: 'attempt_r1_provider-call',
});
const request = { kind: 'message', toBotId: 'b', text: '  hello 🌊\n' } as const;
const members = ['a', 'b', 'c'];
function value(o = origin(), r: unknown = request, m: readonly string[] = members) {
  const result = decideRoomAddress(o, r, m);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function invalid(o: unknown = origin(), r: unknown = request, m: unknown = members) {
  const result = decideRoomAddress(o as RoomDeliveryOrigin, r, m as readonly string[]);
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
}
function ineligible(o = origin(), r: unknown = request, m: readonly string[] = members) {
  expect(decideRoomAddress(o, r, m)).toMatchObject({
    ok: false,
    error: { code: 'invariant_violation' },
  });
}
it.each(['message', 'delegate'] as const)('derives %s sender and exact stable identity', (kind) => {
  for (const grantReferences of [
    [],
    [
      { grantId: 'g1', revision: 1 },
      { grantId: 'g2', revision: 2 },
    ],
  ]) {
    const o = { ...origin(), task: { ...task(), grantReferences } };
    const r = { ...request, kind };
    const expected = {
      senderBotId: 'a',
      recipientBotId: 'b',
      text: request.text,
      kind,
      requestKey: canonicalJson(['room-agent/v1', o.turnId, o.attemptId, o.callId]),
      binding: canonicalJson([
        'ws',
        'room',
        'root',
        'task-a',
        'delivery',
        'a',
        kind,
        'b',
        request.text,
      ]),
    };
    expect(value(o, r)).toEqual(expected);
    expect(value(structuredClone(o), structuredClone(r))).toEqual(expected);
  }
});
it('changes binding only for changed payload or routing context', () => {
  const original = value();
  for (const r of [
    { ...request, text: 'other' },
    { ...request, toBotId: 'c' },
    { ...request, kind: 'delegate' },
  ]) {
    const changed = value(origin(), r);
    expect(changed.requestKey).toBe(original.requestKey);
    expect(changed.binding).not.toBe(original.binding);
  }
  for (const field of ['workspaceId', 'roomId', 'rootId', 'id'] as const) {
    const changed = value({ ...origin(), task: { ...task(), [field]: 'different' } });
    expect(changed.requestKey).toBe(original.requestKey);
    expect(changed.binding).not.toBe(original.binding);
  }
  for (const field of ['turnId', 'attemptId', 'callId'] as const) {
    expect(value({ ...origin(), [field]: 'different' }).requestKey).not.toBe(original.requestKey);
  }
  expect(value({ ...origin(), deliveryId: 'different' }).binding).not.toBe(original.binding);
});
it('accepts parent=root or a delegating bot task and preserves all inputs', () => {
  for (const parentId of ['root', 'parent-bot-task']) {
    const o = { ...origin(), task: { ...task(), parentId } };
    const snapshot = structuredClone({ o, request, members });
    Object.freeze(o.task.members);
    Object.freeze(o.task.grantReferences);
    Object.freeze(o.task);
    Object.freeze(o);
    value(o, Object.freeze(request), Object.freeze(members));
    expect({ o, request, members }).toEqual(snapshot);
  }
});
it('accepts exact UTF-8 bounds for ordinary IDs, compound calls and text', () => {
  const id = '🌊'.repeat(32);
  const callId = '🌊'.repeat(128);
  const o = { ...origin(), turnId: id, attemptId: id, callId };
  expect(value(o, { ...request, text: '🌊'.repeat(4096) }).text).toBe('🌊'.repeat(4096));
  expect(value(o).requestKey).toBe(canonicalJson(['room-agent/v1', id, id, callId]));
  invalid({ ...o, turnId: id + 'x' });
  invalid({ ...o, callId: callId + 'x' });
  invalid(o, { ...request, text: '🌊'.repeat(4096) + 'x' });
});
it('accepts 32 selected/current members and 32 grant references', () => {
  const botIds = ['a', 'b', ...Array.from({ length: 30 }, (_, i) => `bot-${i}`)];
  const grantReferences = Array.from({ length: 32 }, (_, i) => ({
    grantId: `g-${i}`,
    revision: i + 1,
  }));
  value(
    {
      ...origin(),
      task: {
        ...task(),
        members: botIds,
        grantReferences,
        lastDeliverySeq: Number.MAX_SAFE_INTEGER,
      },
    },
    request,
    botIds,
  );
});
it('rejects forged authority, extra/missing keys and nonplain requests', () => {
  for (const r of [
    null,
    [],
    'message',
    {},
    { kind: 'message', toBotId: 'b' },
    { ...request, kind: 'result' },
    { ...request, kind: 'start' },
    ...['senderBotId', 'rootId', 'grantReferences', 'result', 'wake'].map((key) => ({
      ...request,
      [key]: 'forged',
    })),
    Object.assign(Object.create({ inherited: true }), request),
    { ...request, [Symbol('extra')]: true },
  ])
    invalid(origin(), r);
});
it('rejects empty, malformed and oversized text and IDs', () => {
  for (const bad of ['', '  ', '\0', '\ud800', '\udfff', 42, null, undefined]) {
    invalid(origin(), { ...request, text: bad });
    invalid(origin(), { ...request, toBotId: bad });
    for (const key of ['botId', 'turnId', 'deliveryId', 'attemptId', 'callId'])
      invalid({ ...origin(), [key]: bad });
    for (const key of ['id', 'workspaceId', 'roomId', 'rootId', 'parentId', 'assigneeBotId'])
      invalid({ ...origin(), task: { ...task(), [key]: bad } });
  }
  for (const key of ['botId', 'turnId', 'deliveryId', 'attemptId'])
    invalid({ ...origin(), [key]: 'x'.repeat(129) });
  for (const key of ['id', 'workspaceId', 'roomId', 'rootId', 'parentId', 'assigneeBotId'])
    invalid({ ...origin(), task: { ...task(), [key]: 'x'.repeat(129) } });
  invalid(origin(), { ...request, toBotId: 'x'.repeat(129) });
  invalid(origin(), { ...request, text: 'x'.repeat(16385) });
  invalid({ ...origin(), callId: 'x'.repeat(513) });
});
it('rejects malformed bot-task projections and origins', () => {
  for (const t of [
    null,
    {},
    { ...task(), id: 'root' },
    { ...task(), parentId: 'task-a' },
    { ...task(), members: ['b'] },
    { ...task(), status: 'unknown' },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'].map((lastDeliverySeq) => ({
      ...task(),
      lastDeliverySeq,
    })),
  ])
    invalid({ ...origin(), task: t });
  invalid(null);
  invalid({ ...origin(), task: undefined });
});
it('rejects sparse, duplicate, oversized or invalid membership and references', () => {
  const badLists = [
    new Array<string>(2),
    ['a', 'a'],
    ['a', ''],
    ['a', '\ud800'],
    ['a', 'x'.repeat(129)],
    Array.from({ length: 33 }, (_, i) => `bot-${i}`),
  ];
  for (const list of badLists) {
    invalid({ ...origin(), task: { ...task(), members: list } });
    invalid(origin(), request, list);
  }
  invalid({ ...origin(), task: { ...task(), members: [] } });
  for (const refs of [
    null,
    new Array(1),
    [
      { grantId: 'g', revision: 1 },
      { grantId: 'g', revision: 2 },
    ],
    Array.from({ length: 33 }, (_, i) => ({ grantId: `g${i}`, revision: 1 })),
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map((revision) => [
      { grantId: 'g', revision },
    ]),
    [{ grantId: '', revision: 1 }],
    [{ grantId: '\0', revision: 1 }],
    [{ grantId: 'x'.repeat(129), revision: 1 }],
    [{ grantId: 'g', revision: 1, extra: true }],
  ])
    invalid({ ...origin(), task: { ...task(), grantReferences: refs } });
});
it('refuses well-shaped but ineligible routes', () => {
  for (const status of ['waiting', 'paused', 'completed', 'stopped'] as const)
    ineligible({ ...origin(), task: { ...task(), status } });
  ineligible({ ...origin(), botId: 'b' });
  ineligible(origin(), { ...request, toBotId: 'a' });
  ineligible(origin(), { ...request, toBotId: 'outsider' });
  ineligible({ ...origin(), task: { ...task(), members: ['a', 'c'] } });
  for (const current of [[], ['a'], ['b'], ['a', 'c']]) ineligible(origin(), request, current);
});

it('requires a literal status and array membership data without coercion', () => {
  invalid({ ...origin(), task: { ...task(), status: { toString: () => 'ready' } } });
  for (const current of [null, {}, 'a,b']) invalid(origin(), request, current);
  for (const selected of [null, undefined, {}, 'a,b'])
    invalid({ ...origin(), task: { ...task(), members: selected } });
});
it('accepts ordinary UTF-8 ID bounds throughout projections and routing', () => {
  const id = '🌊'.repeat(32);
  for (const key of ['id', 'workspaceId', 'roomId', 'rootId', 'parentId'] as const) {
    value({ ...origin(), task: { ...task(), [key]: id } });
  }
  value({ ...origin(), deliveryId: id });
  value(
    { ...origin(), botId: id, task: { ...task(), assigneeBotId: id, members: [id, 'b'] } },
    request,
    [id, 'b'],
  );
  value(
    {
      ...origin(),
      task: { ...task(), members: ['a', id], grantReferences: [{ grantId: id, revision: 1 }] },
    },
    { ...request, toBotId: id },
    ['a', id],
  );
});
