import { expect, it } from 'vitest';
import { InMemoryToolJournal } from './tool-journal.js';

const context = { taskRunId: 'tr_1', attemptId: 'at_1' };

it('excludes simultaneous claims and fresh identities while a claim is unresolved', async () => {
  const journal = new InMemoryToolJournal();
  expect(
    await Promise.all([
      journal.claim('a', 'edit', context, 'original'),
      journal.claim('b', 'edit', { taskRunId: 'tr_2', attemptId: 'at_2' }, 'new'),
    ]),
  ).toEqual([true, false]);
  expect(await journal.pending()).toEqual([
    {
      ...context,
      id: 'a',
      tool: 'edit',
      fingerprint: 'original',
      outcome: 'started',
    },
  ]);
  await journal.recover('a', context);
  expect((await journal.pending(context.taskRunId))[0]?.outcome).toBe('uncertain');
  expect(await journal.claim('a', 'edit', context, 'changed')).toBe(false);
  await expect(journal.settle('a', 'completed', context)).rejects.toThrow('already settled');
  expect(await journal.pending('other')).toEqual([]);
});

it('keeps settled claims immutable and bound to their run and attempt', async () => {
  const journal = new InMemoryToolJournal();
  expect(await journal.claim('a', 'edit', context, 'original')).toBe(true);
  await journal.settle('a', 'completed', context);
  expect(await journal.pending()).toEqual([]);
  expect(await journal.claim('a', 'edit', context, 'original')).toBe(false);
  expect(await journal.claim('a', 'edit', { ...context, attemptId: 'at_2' }, 'new')).toBe(true);
  await journal.settle('a', 'not_started', { ...context, attemptId: 'at_2' });
  expect(await journal.pending()).toEqual([]);
  await expect(journal.settle('missing', 'failed', context)).rejects.toThrow();
});
