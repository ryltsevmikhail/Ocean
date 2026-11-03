import { expect, it, vi } from 'vitest';
import type { Runtime } from '../runtime.js';
import { runCodingCommand, terminalCodingConfirm } from './coding-command.js';
import { oceanArguments } from './arguments.js';
it('routes a separate exact owner recovery decision without an executable retry', async () => {
  const reconcile = vi.fn(async () => ({
    ok: true,
    value: { applicationId: 'apply', accepted: 'after' },
  }));
  const runtime = { codingApplyResolution: { reconcile } } as unknown as Runtime;
  expect(
    await runCodingCommand(
      runtime,
      oceanArguments([
        'coding',
        'reconcile-apply',
        'apply',
        '--accept',
        'after',
        '--reason',
        'Inspected exact tree',
      ]),
      'owner',
    ),
  ).toEqual({ applicationId: 'apply', accepted: 'after' });
  expect(reconcile).toHaveBeenCalledWith(
    {
      workspaceId: 'ws_ocean',
      applicationId: 'apply',
      accepted: 'after',
      reason: 'Inspected exact tree',
    },
    { confirm: terminalCodingConfirm },
  );
  for (const accepted of ['retry', 'unknown'])
    await expect(
      runCodingCommand(
        runtime,
        oceanArguments([
          'coding',
          'reconcile-apply',
          'apply',
          '--accept',
          accepted,
          '--reason',
          'reason',
        ]),
        'owner',
      ),
    ).rejects.toThrow();
  expect(reconcile).toHaveBeenCalledOnce();
});
