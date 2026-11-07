import { expect, it } from 'vitest';
import { unlimitedBudget } from '@runnets/domain';
import { executeStep } from './commands.js';
import { ProviderError, type ProviderEvent } from './provider.js';
import { runTurn } from './turn.js';
import { provider, setup, usage } from '../test-fixtures/model-turn.js';

for (const dispatch of ['not_sent', 'rejected'] as const) {
  for (const thrown of [false, true]) {
    for (const cancelled of [false, true]) {
      for (const overbudget of [false, true]) {
        it(`holds positive usage before ${dispatch} (throw=${thrown}, cancel=${cancelled}, overbudget=${overbudget})`, async () => {
          const controller = new AbortController();
          const input = await setup([], {
            ...unlimitedBudget(),
            provider_tokens: overbudget ? 1 : null,
          });
          let calls = 0,
            effects = 0;
          const scripted = {
            ...provider([]),
            async *stream(): AsyncIterable<ProviderEvent> {
              calls++;
              yield usage;
              // Losing this weaker event must not erase either debit or the inference fact.
              yield {
                type: 'usage_evidence',
                evidence: { kind: 'unavailable', reason: 'not_reported' },
              };
              if (cancelled) controller.abort();
              const error = new ProviderError('network', 'contradictory nonexecution', {
                dispatch,
              });
              if (thrown) throw error;
              yield { type: 'error', error };
            },
          };
          const result = await runTurn({
            ...input,
            provider: scripted,
            signal: controller.signal,
            tools: {
              definitions: [{ name: 'write', description: 'write', parameters: {} }],
              execute() {
                effects++;
                return Promise.resolve({ output: 'write', isError: false });
              },
            },
          });
          expect(result.kind).toBe('uncertain');
          const state = await input.service.state(input.taskRunId);
          expect(state).toMatchObject({
            status: cancelled ? 'cancelling' : 'reconciling',
            terminal: null,
            budget: { consumed: { provider_tokens: 2 } },
            modelExecution: {
              lastRequest: {
                settlement: {
                  completion: { kind: 'unknown' },
                  usage: { kind: 'actual', tokens: usage.usage },
                },
              },
            },
          });
          expect(calls).toBe(1);
          expect(effects).toBe(0);
          if (state.status === 'absent') throw Error('missing state');
          const retry = await executeStep(
            input.service,
            input.taskRunId,
            'Retry',
            {
              attemptId: state.activeAttempt!.attemptId,
              delayMs: 0,
              dueAt: '2026-11-04T00:00:00.000Z',
            },
            state.version,
          );
          expect(retry.ok).toBe(false);
          const cleanup = await executeStep(
            input.service,
            input.taskRunId,
            'CompleteCleanup',
            { cleanup: 'completed' },
            state.version,
          );
          expect(cleanup.ok).toBe(false);
          const events = await input.service.events(input.taskRunId);
          expect(events.filter((e) => e.type === 'attempt.usage_recorded')).toHaveLength(1);
          for (const type of ['task_run.failed', 'task_run.cancelled', 'task_run.budget_exhausted'])
            expect(events.some((e) => e.type === type)).toBe(false);
        });
      }
    }
  }
}
