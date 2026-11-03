import { expect, it } from 'vitest';
import { terminalCodingConfirm } from './coding-command.js';
it('refuses task ownership confirmation without interactive terminals', async () => {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true)
    expect(await terminalCodingConfirm({ operation: 'reserve', taskId: 'task' })).toBe(false);
});
