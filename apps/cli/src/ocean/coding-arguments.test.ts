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

it('parses explicit coding start authority without a bulk approval option', () => {
  const args = oceanArguments([
    'coding',
    'start',
    '--project',
    '/project',
    '--dev',
    'dev',
    '--review',
    'review',
    '--room',
    'dev-room',
    '--review-room',
    'review-room',
    '--task-id',
    'task',
  ]);
  expect(args.command).toBe('coding');
  expect(args.positional).toEqual(['start']);
  expect(args.flags.get('project')).toBe('/project');
  expect(() => oceanArguments(['coding', 'start', '--yes'])).toThrow();
  expect(oceanArguments(['coding', 'show', 'task']).positional).toEqual(['show', 'task']);
});
