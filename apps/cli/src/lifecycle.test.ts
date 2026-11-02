import { describe, expect, it } from 'vitest';

import { runDemo } from './lifecycle.js';

describe('demo lifecycle', () => {
  it('drives a task run from creation to success', async () => {
    const run = await runDemo();

    expect(run.state.status).toBe('succeeded');
    if (run.state.status === 'absent') throw new Error('aggregate was not created');
    expect(run.state.terminal?.status).toBe('succeeded');
    expect(run.state.attemptCount).toBe(1);
    expect(run.state.lastCommittedCheckpointId).toBe('cp_demo0001');
  });

  it('commits a contiguous event sequence and keeps versions in step', async () => {
    const run = await runDemo();
    const events = run.receipts.flatMap((receipt) => receipt.events);

    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.map((_value, index) => index + 1));

    for (const receipt of run.receipts) {
      expect(receipt.events.length).toBeGreaterThan(0);
    }

    if (run.state.status === 'absent') throw new Error('aggregate was not created');
    expect(run.state.version).toBe(events.length);
  });

  it('records the expected event vocabulary in order', async () => {
    const run = await runDemo();
    const types = run.receipts.flatMap((receipt) => receipt.events).map((event) => event.type);

    expect(types).toEqual([
      'task_run.created',
      'task_run.queued',
      'task_run.admitted',
      'attempt.started',
      'task_run.waiting',
      'task_run.resumed',
      'task_run.checkpointing',
      'checkpoint.committed',
      'task_run.succeeded',
    ]);
  });
});
