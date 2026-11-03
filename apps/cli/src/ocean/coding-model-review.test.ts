import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import {
  ModelCodingReviewer,
  parseCodingReviewResponse,
  type ProviderPort,
} from '@runnets/application';
import { createRuntime } from '../runtime.js';
it('reviews a frozen seeded defect in a separate metered run without tool definitions', async () => {
  const runtime = createRuntime({ mode: 'ephemeral' });
  try {
    let calls = 0;
    const response = {
      verdict: 'changes_requested',
      summary: 'Fix defect',
      findings: [
        {
          path: 'source.ts',
          side: 'after',
          line: 1,
          severity: 'important',
          explanation: 'seeded defect',
        },
      ],
    };
    const provider: ProviderPort = {
      id: 'fixture',
      models: ['fixture'],
      capabilities: { streaming: true, usage: true, reasoning: false },
      async *stream(request) {
        calls++;
        expect(request.tools).toBeUndefined();
        expect(request.messages).toHaveLength(2);
        expect(request.messages[1]?.content).toContain('seeded defect');
        expect(request.messages[1]?.content).not.toContain('private dev transcript');
        yield { type: 'text_delta', text: JSON.stringify(response) };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      },
    };
    const reviewer = new ModelCodingReviewer({
      tasks: runtime.service,
      provider,
      model: 'fixture',
      nextRunId: () => taskRunId('tr_review_fixture'),
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(
      await reviewer.review({
        request: {
          id: 'review',
          workspaceId: 'ws_fixture',
          reviewRoomId: 'room',
          reviewerBotId: 'reviewer',
          status: 'dispatching',
          contextGrant: [],
          binding: {
            taskId: 'task',
            changesetHash: 'hash',
            baseCommit: 'base',
            afterTreeHash: 'after',
            testEvidenceHashes: [],
          },
        },
        changeset: {
          id: 'c',
          hash: 'hash',
          taskId: 'task',
          baseCommit: 'base',
          beforeTreeHash: 'before',
          afterTreeHash: 'after',
          files: [
            {
              path: 'source.ts',
              before: null,
              after: { text: 'seeded defect', mode: '100644', sha256: 'blob' },
            },
          ],
          diff: 'seeded defect',
        },
        evidence: [],
      }),
    ).toEqual(response);
    expect(calls).toBe(1);
    expect((await runtime.service.state(taskRunId('tr_review_fixture'))).status).toBe('succeeded');
  } finally {
    runtime.close();
  }
});
it.each([
  'not JSON',
  '{"verdict":"approve","findings":[],"summary":"ok","tools":["write"]}',
  '{"verdict":"approve","findings":[{"path":"a","side":"after","line":0,"severity":"minor","explanation":"bad"}],"summary":"ok"}',
])('refuses malformed structured reviewer output %s', (text) => {
  expect(() => parseCodingReviewResponse(text)).toThrow();
});
