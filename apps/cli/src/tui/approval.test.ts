import { expect, it } from 'vitest';
import { TuiApproval, terminalText } from './approval.js';

const tool = {
  title: 'Edit a.ts',
  kind: 'edit' as const,
  preview: 'before\nafter',
  execute: () => Promise.resolve({ output: 'ok', isError: false }),
};
it('shows the exact edit and consumes allow-once separately from prompt input', async () => {
  const approval = new TuiApproval(() => {});
  const result = approval.review(tool, new AbortController().signal);
  expect(approval.frame({ columns: 90, rows: 15 })).toContain('before\nafter');
  expect(approval.handle({ type: 'char', value: 'y' })).toBe(true);
  expect(await result).toBe('allow_once');
  expect(approval.frame({ columns: 90, rows: 15 })).toBeNull();
});
it('cancels pending approval without executing anything', async () => {
  const approval = new TuiApproval(() => {});
  const controller = new AbortController();
  const result = approval.review(tool, controller.signal);
  controller.abort();
  expect(await result).toBe('reject');
});
it('strips terminal control sequences from previews and output', () => {
  expect(terminalText('\x1b[2Jtext\x07')).not.toContain('\x1b');
  expect(terminalText('a\nb')).toBe('a\nb');
});
