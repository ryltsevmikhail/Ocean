import { expect, it } from 'vitest';
import { oceanArguments } from './arguments.js';
it('parses explicit coding task without changing legacy send options', () => {
  const plain = oceanArguments(['send', 'room', '--to', 'dev', '--text', 'hello']);
  expect(plain.flags.has('task')).toBe(false);
  const coding = oceanArguments([
    'send',
    'room',
    '--task',
    'task',
    '--to',
    'dev',
    '--text',
    'hello',
  ]);
  expect(coding.flags.get('task')).toBe('task');
  expect(coding.positional).toEqual(plain.positional);
});
it.each(
  [
    ['send', 'room', '--task', 'one', '--task', 'two'],
    ['send', 'room', '--task'],
    ['send', 'room', '--task', ''],
    ['history', 'room', '--task', 'task'],
  ].map((args) => [args]),
)('refuses ambiguous or misplaced coding task %j', (args) => {
  expect(() => oceanArguments(args)).toThrow();
});
