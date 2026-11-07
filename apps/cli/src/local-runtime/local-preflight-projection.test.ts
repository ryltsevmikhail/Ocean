import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { DirectChatService } from '@runnets/application';
import { fixture as localHttp } from '../../test-fixtures/local-model.js';
import { taskRunId } from '@runnets/domain';
import { preflightFixture } from '../../test-fixtures/local-preflight.js';

it('releases a durably failed first local metadata preflight without inference or a reply', async () => {
  const f = preflightFixture();
  try {
    const admitted = f.chat.submit(f.input);
    if (!admitted.ok) throw Error('admission');
    const turn = await admitted.value.completion;
    if (!turn) throw Error('completion');
    const state = await f.tasks.state(taskRunId(turn.taskRunId));
    expect(state).toMatchObject({
      status: 'failed',
      terminal: { status: 'failed' },
      modelExecution: {
        startedRequests: 1,
        lastRequest: {
          ordinal: 1,
          settlement: { completion: { kind: 'not_sent' }, usage: { kind: 'unavailable' } },
        },
      },
    });
    expect(f.http.requests.filter((r) => r.url.endsWith('/api/chat'))).toHaveLength(0);
    expect(f.http.requests.some((r) => r.url.endsWith('/api/version'))).toBe(true);
    expect(turn.status).toBe('failed');
    expect(f.store.conversations.atomic((tx) => tx.activeChatTurn(f.input.roomId))).toBeNull();
    expect(f.conversations.history('work', f.input.roomId)).toMatchObject({
      value: [{ author: 'user' }],
    });
    const second = f.chat.submit({ ...f.input, requestId: 'second' });
    expect(second.ok).toBe(true);
    if (second.ok) await second.value.completion;
  } finally {
    f.close();
  }
});

it.each(['dispatching', 'uncertain'] as const)(
  'recovers the durable failure/%s crash gap without dispatch',
  async (status) => {
    const f = preflightFixture();
    try {
      const sent = await f.chat.send(f.input);
      if (!sent.ok || !('id' in sent.value)) throw Error('fixture turn');
      const turn = sent.value;
      f.store.conversations.atomic((tx) => tx.putChatTurn({ ...turn, status }));
      const before = await f.tasks.events(taskRunId(sent.value.taskRunId));
      const count = f.http.requests.length;
      await f.chat.recover();
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(turn.id)?.status)).toBe('failed');
      expect(await f.tasks.events(taskRunId(sent.value.taskRunId))).toEqual(before);
      expect(f.http.requests).toHaveLength(count);
    } finally {
      f.close();
    }
  },
);

it.each([
  'scoped',
  'legacy',
  'foreign',
  'reviewed',
  'unreadable',
  'version',
  'activation',
  'attempt',
  'unknown',
  'unsettled',
  'reconciling',
  'cancelling',
] as const)('preserves conservative recovery for %s evidence', async (control) => {
  const f = preflightFixture();
  try {
    const sent = await f.chat.send(f.input);
    if (!sent.ok || !('id' in sent.value)) throw Error('fixture turn');
    const turn = { ...sent.value, status: 'uncertain' as const };
    f.store.conversations.atomic((tx) => tx.putChatTurn(turn));
    if (control === 'reviewed') {
      const seen = await f.reviews.review('work', turn.taskRunId);
      if (!seen.ok) throw Error('review');
      const ack = await f.reviews.acknowledge(
        {
          workspaceId: 'work',
          taskRunId: turn.taskRunId,
          requestId: 'review',
          reviewVersion: seen.value.version,
          reason: 'fixture',
        },
        { confirm: async () => true },
        f.input.signal,
      );
      expect(ack.ok).toBe(true);
    }
    if (control === 'legacy') f.legacyClaim();
    if (['scoped', 'foreign'].includes(control))
      await f.store.tools.claim(
        'claim',
        'plugin',
        {
          taskRunId:
            control === 'legacy' ? '' : control === 'foreign' ? 'tr_foreign' : turn.taskRunId,
          attemptId: 'attempt',
        },
        'fixture',
      );
    const state = f.tasks.state.bind(f.tasks);
    f.tasks.state = async (id) => {
      if (control === 'unreadable') throw Error('unreadable');
      const value = await state(id);
      if (value.status === 'absent') return value;
      if (control === 'version') return { ...value, version: value.version - 1 };
      if (control === 'attempt') return { ...value, attemptCount: 2 };
      if (control === 'reconciling' || control === 'cancelling')
        return { ...value, status: control };
      const e = value.modelExecution;
      if (!e) throw Error('execution');
      if (control === 'activation')
        return {
          ...value,
          modelExecution: {
            ...e,
            activation: { ...e.activation, admittedAt: '2026-11-03T00:00:00.000Z' },
          },
        };
      if (control === 'unknown' || control === 'unsettled')
        return {
          ...value,
          modelExecution: {
            ...e,
            lastRequest: {
              ...e.lastRequest,
              settlement:
                control === 'unsettled'
                  ? null
                  : { ...e.lastRequest.settlement!, completion: { kind: 'unknown' } },
            },
          },
        };
      return value;
    };
    await f.chat.recover();
    expect(f.store.conversations.atomic((tx) => tx.chatTurn(turn.id)?.status)).toBe(
      control === 'foreign' ? 'failed' : 'uncertain',
    );
    if (['scoped', 'legacy', 'foreign'].includes(control))
      expect(await f.store.tools.pending()).toHaveLength(1);
    expect(f.http.requests.filter((r) => r.url.endsWith('/api/chat'))).toHaveLength(0);
  } finally {
    f.close();
  }
});

it('holds a later local not_sent request after an earlier real tool round', async () => {
  const f = preflightFixture();
  try {
    let tools = 0,
      inference = 0;
    const normal = localHttp({}, [
      JSON.stringify({
        model: 'qwen3:1.7b',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'fixture_tool', arguments: {} } }],
        },
        done: true,
        done_reason: 'stop',
      }) + '\n',
    ]);
    const drift = f.http.http.send.bind(f.http.http);
    f.http.http.send = async (request) => {
      if (tools) return drift(request);
      f.http.requests.push(request);
      if (request.url.endsWith('/api/chat')) inference++;
      return normal.http.send(request);
    };
    const chat = new DirectChatService({
      store: f.store.conversations,
      tasks: f.tasks,
      clock: f.clock,
      nextId: f.nextId,
      reviews: f.reviews,
      grantedTools: {
        forTurn: async () => ({
          callDigest: (text: string) => createHash('sha256').update(text).digest('hex'),
          cleanupConfirmed: true,
          instructions: 'fixture',
          definitions: [
            {
              name: 'fixture_tool',
              description: 'fixture',
              parameters: { type: 'object', properties: {} },
            },
          ],
          execute: async () => {
            tools++;
            return { output: 'done', isError: false };
          },
        }),
      },
    });
    const result = await chat.send(f.input);
    if (!result.ok || !('id' in result.value)) throw Error('fixture result');
    expect(tools).toBe(1);
    expect(inference).toBe(1);
    expect(await f.tasks.state(taskRunId(result.value.taskRunId))).toMatchObject({
      status: 'failed',
      modelExecution: {
        startedRequests: 2,
        lastRequest: { ordinal: 2, settlement: { completion: { kind: 'not_sent' } } },
      },
    });
    const turn = result.value;
    expect(result.value.status).toBe('uncertain');
    await chat.recover();
    expect(f.store.conversations.atomic((tx) => tx.chatTurn(turn.id)?.status)).toBe('uncertain');
  } finally {
    f.close();
  }
});
