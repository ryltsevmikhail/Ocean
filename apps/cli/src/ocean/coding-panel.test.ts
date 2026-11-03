import { expect, it, vi } from 'vitest';
import type { Runtime } from '../runtime.js';
import { codingPanelLines } from './coding-panel.js';
it('captures only the selected task owning room and displays frozen diff and current test evidence', async () => {
  const capture = vi.fn(async () => ({
    ok: true,
    value: {
      hash: 'hash',
      baseCommit: 'base',
      afterTreeHash: 'tree',
      files: [{ path: 'new', before: null, after: { mode: '100755' } }],
      diff: '+full diff last line',
    },
  }));
  const runtime = {
    coding: {
      inspect: () => ({
        ok: true,
        value: {
          id: 'task',
          workspaceId: 'workspace',
          ownerRoomId: 'room',
          devBotId: 'dev',
          policyVersion: 1,
          policy: { testPresets: [{ id: 'test' }] },
        },
      }),
    },
    codingChanges: { capture },
    codingEvidence: { latestForPreset: () => null },
  } as unknown as Runtime;
  const lines = await codingPanelLines(runtime, 'room', 'task');
  expect(lines.join('\n')).toContain('Changeset hash');
  expect(lines.join('\n')).toContain('new: absent → 100755');
  expect(lines.join('\n')).toContain('test: no recorded result');
  expect(lines.at(-1)).toBe('+full diff last line');
  expect(capture).toHaveBeenCalledOnce();
  await expect(codingPanelLines(runtime, 'wrong-room', 'task')).rejects.toThrow('coding_denied');
  expect(capture).toHaveBeenCalledOnce();
  expect(await codingPanelLines(runtime, 'room', undefined)).toEqual([
    'No coding task selected. Start TUI with --task TASK.',
  ]);
});
