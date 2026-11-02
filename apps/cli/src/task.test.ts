import { expect, it } from 'vitest';
import { taskArguments } from './task.js';

it('keeps task text and selects an explicit workspace', () => {
  expect(taskArguments(['--cwd', '/workspace', 'fix', 'the failing test'])).toEqual({
    workspace: '/workspace',
    prompt: 'fix the failing test',
  });
});
it('rejects a missing workspace option value', () => {
  expect(() => taskArguments(['--cwd'])).toThrow('requires a directory');
});
