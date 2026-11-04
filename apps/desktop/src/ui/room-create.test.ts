import { expect, it } from 'vitest';
import type { Command } from '../protocol.js';
import { submitCreation, type CreateCall, type RoomCreateDraft } from './room-create.js';

const base: RoomCreateDraft = {
  dialog: 'room',
  kind: 'group',
  selected: ['bot-a', 'bot-b'],
  title: 'Ocean Team',
  handle: 'dev',
  name: 'Dev',
  role: 'Role',
  model: 'deepseek-flash',
};
function fakeCall(reply: { id: string }) {
  const calls: Command[] = [];
  const call = (async (command: Command) => {
    calls.push(command);
    return { kind: 'room', data: reply } as never;
  }) as CreateCall;
  return { call, calls };
}

it('reports the created room so the desktop can open it again', async () => {
  const group = fakeCall({ id: 'room-new' });
  await expect(submitCreation(base, group.call)).resolves.toBe('room-new');
  expect(group.calls.at(-1)).toMatchObject({
    op: 'group',
    title: 'Ocean Team',
    bots: ['bot-a', 'bot-b'],
  });
  const direct = fakeCall({ id: 'room-direct' });
  await expect(submitCreation({ ...base, kind: 'direct' }, direct.call)).resolves.toBe(
    'room-direct',
  );
  expect(direct.calls.at(-1)).toMatchObject({ op: 'direct', bot: 'bot-a' });
});

it('keeps the current room when the dialog created a bot instead', async () => {
  const bot = fakeCall({ id: 'bot-created' });
  await expect(submitCreation({ ...base, dialog: 'bot' }, bot.call)).resolves.toBeNull();
  expect(bot.calls.at(-1)).toMatchObject({
    op: 'bot',
    handle: 'dev',
    model: 'deepseek-flash',
  });
});
