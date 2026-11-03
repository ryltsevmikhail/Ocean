import { expect, it } from 'vitest';
import { commands } from '../protocol.js';
const send = {
  op: 'send',
  room: 'room_1',
  requestId: crypto.randomUUID(),
  to: 'dev',
  text: 'inspect',
};
it.each([
  { op: 'shell' },
  { ...send, workspace: '/tmp' },
  { ...send, text: '--version' },
  { ...send, room: '../../profile' },
])('rejects invalid renderer operations before runtime dispatch', (request) => {
  expect(commands.safeParse(request).success).toBe(false);
});
it('keeps shell syntax literal and addresses only the chosen bot', () => {
  const input = { ...send, text: '$(example) | cat' };
  expect(commands.parse(input)).toEqual(input);
});
