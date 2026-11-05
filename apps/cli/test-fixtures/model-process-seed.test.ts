// eslint-disable-next-line no-restricted-imports -- Same-app source contract; child executes dist.
import type * as SourceModule1 from '../src/ocean/profile.js';
const { openOceanProfile }: typeof SourceModule1 = await import(String('../dist/ocean/profile.js'));
import { categorySeed } from './model-process-category-seed.ts';
const profile = process.argv[2]!;
const runtime = openOceanProfile(profile, true);
await runtime.ready;
const execute = runtime.conversations.execute.bind(runtime.conversations);
execute({ type: 'BindWorkspace', requestId: 'init', workspaceId: 'ws_ocean', root: profile });
const bot = execute({
  type: 'CreateBot',
  workspaceId: 'ws_ocean',
  requestId: 'bot',
  handle: 'dev',
  name: 'Dev',
  role: 'Fixture',
  provider: 'deepseek',
  model: 'deepseek-flash',
});
if (!bot.ok || bot.value.kind !== 'bot') throw Error('fixture_bot');
const room = execute({
  type: 'OpenDirectRoom',
  workspaceId: 'ws_ocean',
  requestId: 'room',
  botId: bot.value.data.id,
});
if (!room.ok || room.value.kind !== 'room') throw Error('fixture_room');
const runs = await categorySeed(runtime, bot.value.data, room.value.data.id);
runtime.close();
process.send!({
  ready: {
    runs,
    botId: bot.value.data.id,
    roomId: room.value.data.id,
    profile: import.meta.resolve('../dist/ocean/profile.js'),
  },
});
