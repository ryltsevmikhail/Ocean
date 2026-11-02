import { expect, it, vi } from 'vitest';
import type { Runtime } from '../runtime.js';
import { oceanArguments } from './arguments.js';
import { runCodingCommand, terminalCodingConfirm } from './coding-command.js';
it('routes exact saved artifact/review identity without recapturing changes or invoking a provider', async () => {
  const receipt = { id: 'request', status: 'completed' };
  const apply = vi.fn(async () => ({ ok: true, value: receipt }));
  const runtime = {
    coding: {
      inspect: () => ({
        ok: true,
        value: { workspaceId: 'ws_ocean', id: 'task', baseCommit: 'base' },
      }),
    },
    codingApply: { apply },
    codingChanges: {
      capture: () => {
        throw Error('must not recapture');
      },
    },
  } as unknown as Runtime;
  const result = await runCodingCommand(
    runtime,
    oceanArguments([
      'coding',
      'apply',
      'task',
      '--changeset',
      'exact-hash',
      '--review-request',
      'exact-review',
    ]),
    'request',
  );
  expect(result).toEqual(receipt);
  expect(apply).toHaveBeenCalledWith(
    {
      id: 'request',
      workspaceId: 'ws_ocean',
      taskId: 'task',
      changesetHash: 'exact-hash',
      reviewRequestId: 'exact-review',
      expectedBase: 'base',
    },
    { confirm: terminalCodingConfirm },
  );
});
it('refuses missing exact artifact/review parameters before dispatch', async () => {
  const apply = vi.fn();
  const runtime = {
    codingApply: { apply },
    coding: { inspect: () => ({ ok: true, value: { baseCommit: 'base' } }) },
  } as unknown as Runtime;
  for (const flags of [[], ['--changeset', 'hash'], ['--review-request', 'review']])
    await expect(
      runCodingCommand(runtime, oceanArguments(['coding', 'apply', 'task', ...flags]), 'request'),
    ).rejects.toThrow();
  expect(apply).not.toHaveBeenCalled();
});

it('lists application identities without hiding unrelated unresolved effects', async () => {
  const runtime = {
    toolJournal: {
      pending: async () => [
        { id: 'apply', tool: 'coding_apply', outcome: 'uncertain' },
        { id: 'write', tool: 'write_file', outcome: 'uncertain' },
      ],
    },
  } as unknown as Runtime;
  expect(await runCodingCommand(runtime, oceanArguments(['coding', 'pending']), 'list')).toEqual({
    applications: [{ applicationId: 'apply', outcome: 'uncertain' }],
    otherEffects: [{ id: 'write', tool: 'write_file', outcome: 'uncertain' }],
  });
});
