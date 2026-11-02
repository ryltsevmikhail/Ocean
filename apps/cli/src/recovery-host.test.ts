import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { reconcileInterrupted, ToolService } from '@runnets/application';
import { AcpAgent } from './acp/agent.js';
import { createTaskRun } from './acp/session.js';
import { JsonRpcPeer } from './acp/transport.js';
import { createRuntime } from './runtime.js';
import { TuiApp } from './tui/app.js';

it('shows recovered tasks in TUI and refuses continuation with missing history', async () => {
  const runtime = createRuntime({ clock: { now: () => new Date('2026-11-01T00:00:00Z') } });
  const id = taskRunId('tr_losthistory');
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  await createTaskRun({
    service: runtime.service,
    taskRunId: id,
    conversationId: 'cv_lost',
    workspaceId: 'ws_lost',
    model: 'fake',
    parentTaskRunId: null,
  });
  const journal = runtime.toolJournal;
  if (journal === undefined) throw new Error('shared journal required');
  const recovery = await reconcileInterrupted(runtime.service, journal);
  const app = new TuiApp({
    service: runtime.service,
    provider: null,
    input,
    output,
    recovered: recovery.tasks.map((task) => task.taskRunId),
  });
  try {
    await app.start();
    input.write('\x1bOQ\x1b[A\r');
    expect(app.selectedRun()?.taskRunId).toBe(id);
    expect(app.frame()).toContain('history unavailable');
    expect(app.selectedRun()?.aggregate?.status).toBe('reconciling');
    input.write('continue\r');
    await app.idle();
    expect(app.frame()).toContain('history unavailable');
    expect((await runtime.service.state(id)).status).toBe('reconciling');
    expect((await runtime.service.events(id)).map((event) => event.type)).not.toContain(
      'attempt.started',
    );
  } finally {
    app.stop();
    runtime.close();
  }
});

it('warns ACP clients about interruption without advertising conversation resume', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let frames = '';
  output.on('data', (chunk: Buffer) => {
    frames += chunk.toString('utf8');
  });
  const runtime = createRuntime({ clock: { now: () => new Date('2026-11-01T00:00:00Z') } });
  const agent = new AcpAgent(new JsonRpcPeer({ input, output }), runtime.service, {
    recovery: {
      tasks: [{ taskRunId: taskRunId('tr_lost'), status: 'reconciling', reason: 'lost' }],
      effects: [],
    },
  });
  try {
    expect((await agent.initialize({ protocolVersion: 1 })).agentCapabilities?.loadSession).toBe(
      false,
    );
    await agent.newSession({ cwd: '/workspace' });
    expect(frames).toContain('Interrupted work requires reconciliation');
    expect(frames).toContain('history was not restored');
  } finally {
    input.end();
    runtime.close();
  }
});

it('shares ephemeral claims across tool services without claiming restart durability', async () => {
  const runtime = createRuntime({ clock: { now: () => new Date('2026-11-01T00:00:00Z') } });
  const journal = runtime.toolJournal;
  if (journal === undefined) throw new Error('shared journal required');
  let executions = 0;
  const executor = {
    definitions: [],
    prepare: async () => ({
      title: 'effect',
      kind: 'read' as const,
      preview: '',
      execute: async () => {
        executions++;
        return { output: 'unknown', isError: true, uncertain: true };
      },
    }),
  };
  const permission = { review: async () => 'reject' as const };
  const first = new ToolService(executor, permission, journal);
  const second = new ToolService(executor, permission, journal);
  try {
    const signal = new AbortController().signal;
    const call = { id: 'first', name: 'read', arguments: '{}' };
    await first.execute(call, signal, { taskRunId: 'tr_one', attemptId: 'at_one' });
    const result = await second.execute({ ...call, id: 'new' }, signal, {
      taskRunId: 'tr_two',
      attemptId: 'at_two',
    });
    expect(result.uncertain).toBe(true);
    expect(executions).toBe(1);
    expect(runtime.durable).toBe(false);
  } finally {
    runtime.close();
  }
});
