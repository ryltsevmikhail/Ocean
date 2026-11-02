import { ChatRunBook } from './chat-book.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ModelCodingReviewer, type ProviderPort } from '@runnets/application';
import { codingTestPassed, taskRunId } from '@runnets/domain';
import {
  codingWorkflowFixture,
  faultyMath,
  initialMath,
  repairedMath,
} from './coding-workflow-fixture.js';
function devProvider(content: string, test: boolean): ProviderPort {
  let round = 0;
  const calls = [
    { id: 'read', name: 'read_file', arguments: JSON.stringify({ path: 'math.cjs' }) },
    { id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'math.cjs', content }) },
    ...(test ? [{ id: 'test', name: 'run_test', arguments: '{"presetId":"test"}' }] : []),
  ];
  return {
    id: 'fixture',
    models: ['fixture'],
    capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
    async *stream(request) {
      expect(request.tools?.some((tool) => tool.name === 'run_test')).toBe(true);
      const call = calls[round++];
      if (call) yield { type: 'tool_call', call };
      else yield { type: 'text_delta', text: 'Fixture dev response' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield {
        type: 'completed',
        stopReason: call ? 'tool_calls' : 'stop',
        rawStopReason: call ? 'tool_calls' : 'stop',
      };
    },
  };
}
it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['direct', 'group'] as const)(
  'qualifies denied edit, real failed test, seeded review finding, repair and exact owner apply in %s',
  async (kind) => {
    const f = await codingWorkflowFixture(kind);
    try {
      expect(await f.send('denied', devProvider(faultyMath, false))).toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
      expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(initialMath);
      expect(f.runtime.codingEvidence!.list('task')).toEqual([]);
      expect(await f.send('faulty', devProvider(faultyMath, true))).toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
      const failed = f.runtime.codingEvidence!.list('task');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.exitCode).not.toBe(0);
      expect(codingTestPassed(failed[0]!)).toBe(false);
      const bad = await f.capture('bad');
      expect(bad.files[0]).toMatchObject({ path: 'math.cjs', after: { text: faultyMath } });
      let modelCalls = 0;
      const review = async (id: string, changesetHash: string, repaired: boolean) => {
        const requested = await f.runtime.codingReview!.request(
          { id, workspaceId: 'ws_ocean', taskId: 'task', changesetHash },
          { confirm: async () => true },
        );
        expect(requested.ok).toBe(true);
        const provider: ProviderPort = {
          id: 'fixture',
          models: ['fixture'],
          capabilities: { streaming: true, usage: true, reasoning: false },
          async *stream(request) {
            modelCalls++;
            expect(request.tools).toBeUndefined();
            const input = JSON.stringify(request.messages);
            expect(input).not.toContain('private-dev-marker');
            expect(input).toContain(repaired ? 'a+b' : 'a-b');
            yield {
              type: 'text_delta',
              text: JSON.stringify({
                verdict: repaired ? 'approve' : 'changes_requested',
                summary: repaired
                  ? 'Exact repair and passed test'
                  : 'Subtraction violates addition contract',
                findings: repaired
                  ? []
                  : [
                      {
                        path: 'math.cjs',
                        side: 'after',
                        line: 1,
                        severity: 'important',
                        explanation: 'a-b returns -1 for (2,3); use a+b to return 5.',
                      },
                    ],
              }),
            };
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
            yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
          },
        };
        const result = await f.runtime.codingReview!.dispatch(
          id,
          new ModelCodingReviewer({
            tasks: f.runtime.service,
            provider,
            model: 'fixture',
            nextRunId: () => taskRunId('tr_' + id),
            signal: new AbortController().signal,
            emit: () => {},
          }),
        );
        expect(result.ok).toBe(true);
        return result;
      };
      const first = await review('review_bad', bad.hash, false);
      expect(first).toMatchObject({
        ok: true,
        value: { verdict: 'changes_requested', findings: [{ path: 'math.cjs', line: 1 }] },
      });
      let ownerCalls = 0;
      const apply = (id: string, hash: string, reviewRequestId: string, allow: boolean) =>
        f.runtime.codingApply!.apply(
          {
            id,
            workspaceId: 'ws_ocean',
            taskId: 'task',
            changesetHash: hash,
            reviewRequestId,
            expectedBase: f.base,
          },
          {
            confirm: async (preview) => {
              ownerCalls++;
              expect(preview.changeset.hash).toBe(hash);
              return allow;
            },
          },
        );
      expect((await apply('reject_bad', bad.hash, 'review_bad', true)).ok).toBe(false);
      expect(ownerCalls).toBe(0);
      expect(await f.send('repair', devProvider(repairedMath, true))).toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
      const good = await f.capture('good');
      expect(good.hash).not.toBe(bad.hash);
      const tests = f.runtime.codingEvidence!.list('task');
      expect(tests).toHaveLength(2);
      expect(codingTestPassed(tests[1]!)).toBe(true);
      expect((await apply('stale_review', good.hash, 'review_bad', true)).ok).toBe(false);
      expect(ownerCalls).toBe(0);
      const book = new ChatRunBook(f.runtime, f.room, null, 'task');
      await book.restore();
      const panel = await book.add(null);
      await book.loadChangeset(panel);
      expect(panel.codingLines?.join('\n')).toContain(good.hash);
      expect(panel.codingLines?.join('\n')).toContain('exit=0 reason=exit cleanup=true');
      expect(panel.codingLines?.join('\n')).not.toContain('private-dev-marker');
      await review('review_good', good.hash, true);
      expect(modelCalls).toBe(2);
      expect((await apply('owner_denied', good.hash, 'review_good', false)).ok).toBe(false);
      expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(initialMath);
      expect((await apply('apply', good.hash, 'review_good', true)).ok).toBe(true);
      expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(repairedMath);
      expect((await apply('apply', good.hash, 'review_good', true)).ok).toBe(false);
      expect(ownerCalls).toBe(2);
      expect(f.previews).toEqual(['write', 'write', 'test', 'write', 'test']);
      expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
      expect(f.git('diff', '--cached')).toBe('');
      expect(await f.runtime.toolJournal!.pending()).toEqual([]);
    } finally {
      f.close();
    }
  },
  60000,
);
