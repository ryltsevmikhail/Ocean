/**
 * Layout tests: frames are a pure function of UI state and committed data, so
 * assertions check visible columns, truncation and panel contents directly.
 */

import { describe, expect, it } from 'vitest';
import {
  conversationId,
  policyId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type CommandPayloads,
  type CommandType,
  type EventEnvelope,
  type TaskRunAggregate,
  type TaskRunId,
} from '@runnets/domain';
import type { TaskRunService } from '@runnets/application';

import { executeStep } from '../engine/commands.js';
import { createService } from '../lifecycle.js';
import { initialUiState, type UiState } from './state.js';
import type { StreamLine } from './types.js';
import { renderFrame, type RunViewData } from './view.js';

const SIZE = { columns: 100, rows: 30 };
const MODEL = 'fake-model';

async function step<TType extends CommandType>(
  service: TaskRunService,
  id: TaskRunId,
  type: TType,
  payload: CommandPayloads[TType],
  version: number,
): Promise<void> {
  const result = await executeStep(service, id, type, payload, version);
  if (!result.ok) throw new Error(`${type} failed: ${result.error.code}`);
}

async function committedRun(): Promise<{
  aggregate: TaskRunAggregate;
  events: readonly EventEnvelope[];
}> {
  const service = createService();
  const id = taskRunId('tr_view0001');
  await step(
    service,
    id,
    'CreateTaskRun',
    {
      conversationId: conversationId('cv_view0001'),
      workspaceId: workspaceId('ws_view0001'),
      parentTaskRunId: null,
      model: MODEL,
      policyId: policyId('pl_view0001'),
      budget: { ...unlimitedBudget(), provider_tokens: 100 },
    },
    0,
  );
  await step(service, id, 'Admit', {}, 1);
  await step(service, id, 'Schedule', {}, 2);
  await step(
    service,
    id,
    'StartAttempt',
    { attemptId: 'at_view0001', reason: 'initial', provider: 'fake', model: MODEL },
    3,
  );
  await step(
    service,
    id,
    'RecordUsage',
    { attemptId: 'at_view0001', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    4,
  );
  await step(service, id, 'Complete', { summary: 'turn completed', attemptId: 'at_view0001' }, 5);
  const [aggregate, events] = await Promise.all([service.state(id), service.events(id)]);
  return { aggregate, events };
}

function runData(
  taskRunId: TaskRunId,
  aggregate: TaskRunAggregate | null,
  events: readonly EventEnvelope[] = [],
  stream: readonly StreamLine[] = [],
  liveMode: string | null = null,
): RunViewData {
  return { taskRunId, aggregate, events, stream, liveMode };
}

function frameOf(
  ui: UiState,
  runs: readonly RunViewData[],
  size: { columns: number; rows: number } = SIZE,
): string {
  return renderFrame({ ui, runs, model: MODEL, provider: 'fake', size });
}

function linesOf(frame: string): string[] {
  return frame.split('\n');
}

describe('renderFrame', () => {
  it('gives the main frame to the reply and keeps fixed-height bottom input', async () => {
    const { aggregate, events } = await committedRun();
    const runs = [
      runData(taskRunId('tr_view0001'), aggregate, events, [
        { kind: 'text', text: 'A readable answer' },
      ]),
    ];
    const frame = frameOf(initialUiState(), runs);
    expect(linesOf(frame)).toHaveLength(SIZE.rows);
    for (const line of linesOf(frame)) expect(line).toHaveLength(SIZE.columns);
    expect(frame).toContain('A readable answer');
    expect(frame).toContain('tokens 15');
    expect(frame).not.toContain('DETAILS');
    expect(frame).not.toContain('EVENTS');
    expect(frame).not.toContain('provider_tokens');
    expect(linesOf(frame).at(-2)).toContain('> ');
  });
  it('opens task selection and detailed state only on request', async () => {
    const { aggregate, events } = await committedRun();
    const runs = [
      runData(taskRunId('tr_view0001'), aggregate, events),
      runData(taskRunId('tr_view0002'), null),
    ];
    const tasks = frameOf({ ...initialUiState(), focus: 'runs' }, runs);
    expect(tasks).toContain('> 1. tr_view0001 succeeded');
    expect(tasks).toContain('2. tr_view0002 loading');
    const details = frameOf({ ...initialUiState(), focus: 'details' }, runs);
    expect(details).toContain('attempts: 1 (active: at_view0001)');
    expect(details).toContain('terminal: succeeded');
    expect(details).toContain('provider_tokens: 15 / 100');
  });
  it('keeps reasoning hidden until explicitly enabled', async () => {
    const { aggregate, events } = await committedRun();
    const stream: StreamLine[] = [
      { kind: 'thought', text: 'private plan' },
      { kind: 'text', text: 'Hello' },
    ];
    const runs = [runData(taskRunId('tr_view0001'), aggregate, events, stream, 'running')];
    const normal = frameOf({ ...initialUiState(), busy: true }, runs);
    expect(normal).toContain('running');
    expect(normal).toContain('Hello');
    expect(normal).not.toContain('private plan');
    expect(frameOf({ ...initialUiState(), showThoughts: true }, runs)).toContain('private plan');
  });
  it('scrolls the independent events panel through committed events', async () => {
    const { aggregate, events } = await committedRun();
    const runs = [runData(taskRunId('tr_view0001'), aggregate, events)];
    const newest = frameOf({ ...initialUiState(), focus: 'events' }, runs, {
      columns: 70,
      rows: 10,
    });
    expect(newest).toContain('#006 task_run.succeeded');
    expect(newest).not.toContain('#001 task_run.created');
    const older = frameOf({ ...initialUiState(), focus: 'events', eventScroll: 3 }, runs, {
      columns: 70,
      rows: 10,
    });
    expect(older).toContain('#001 task_run.created');
    expect(older).not.toContain('#006 task_run.succeeded');
  });
  it('keeps a small screen usable and clamps invalid dimensions', () => {
    const runs = [runData(taskRunId('tr_view0001'), null, [], [{ kind: 'text', text: 'answer' }])];
    const small = frameOf(initialUiState(), runs, { columns: 20, rows: 6 });
    expect(linesOf(small)).toHaveLength(6);
    for (const line of linesOf(small)) expect(line).toHaveLength(20);
    expect(small).toContain('answer');
    expect(small).not.toContain('Details');
    const minimum = frameOf(initialUiState(), [], { columns: 1, rows: 1 });
    expect(linesOf(minimum)).toHaveLength(4);
    for (const line of linesOf(minimum)) expect(line).toHaveLength(20);
  });
  it('offers an empty dialogue and retains hidden drafts when browsing panels', () => {
    expect(frameOf(initialUiState(), [])).toContain('Write a message below');
    const ui: UiState = { ...initialUiState(), prompt: 'draft', cursor: 5 };
    expect(frameOf(ui, [])).toContain('> draft▏');
    expect(frameOf({ ...ui, focus: 'runs' }, [])).toContain('> draft');
  });
  it('keeps the end of a long input visible rather than clipping it off-screen', () => {
    const prompt = 'word '.repeat(150);
    const frame = frameOf({ ...initialUiState(), prompt, cursor: prompt.length }, []);
    expect(linesOf(frame).slice(-5).join('\n')).toContain('▏');
    expect(frame).not.toContain('…');
  });
});
