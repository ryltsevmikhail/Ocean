import { expect, it } from 'vitest';
import { cliArguments } from './arguments.js';
const send = {
  op: 'send',
  room: 'room_1',
  requestId: '12345678-1234-4123-8123-123456789abc',
  to: 'dev',
  text: 'inspect',
};
it.each([
  { op: 'shell' },
  { ...send, workspace: '/tmp' },
  { ...send, text: '--version' },
  { ...send, room: '../../profile' },
  { ...send, to: null, text: ' @review inspect' },
])('rejects invalid IPC operations before CLI dispatch', (request) => {
  expect(() => cliArguments(request, '/profile', '/workspace')).toThrow();
});
it('keeps shell syntax literal and addresses only the chosen bot', () => {
  const text = '$(example) | cat';
  expect(cliArguments({ ...send, text }, '/profile', '/workspace')).toEqual([
    'send',
    'room_1',
    '--text',
    text,
    '--to',
    'dev',
    '--json',
    '--profile',
    '/profile',
    '--request-id',
    send.requestId,
  ]);
});
