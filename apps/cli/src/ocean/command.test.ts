import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ModelRequest, ProviderPort } from '@runnets/application';
import { runOceanCommand } from './command.js';
import { openOceanProfile } from './profile.js';
import { TuiApp } from '../tui/app.js';
import { ChatRunBook } from './chat-book.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-cli-chat-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, profile: join(root, 'state') };
}
async function command(
  profile: string,
  args: readonly string[],
  provider: ProviderPort | null = null,
) {
  const output = new PassThrough();
  const error = new PassThrough();
  let raw = '';
  output.on('data', (b: Buffer) => {
    raw += b.toString();
  });
  const code = await runOceanCommand([...args, '--profile', profile, '--json'], {
    output,
    error,
    provider,
  });
  return { code, result: JSON.parse(raw) };
}
function model(requests: ModelRequest[]): ProviderPort {
  return {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'Hello from bot' };
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
async function setup() {
  const { root, profile } = temporary();
  expect((await command(profile, ['init', '--workspace', root])).code).toBe(0);
  expect(
    (
      await command(profile, [
        'bot',
        'add',
        '--handle',
        'dev',
        '--name',
        'Developer',
        '--role',
        'Role',
        '--provider',
        'test',
        '--model',
        'test',
      ])
    ).code,
  ).toBe(0);
  const room = await command(profile, ['room', 'direct', '--bot', 'dev']);
  return { profile, roomId: room.result.data.data.id as string };
}
it('CLI commands share stored bot profiles, replies and restored model context', async () => {
  const { profile, roomId } = await setup();
  const requests: ModelRequest[] = [];
  const provider = model(requests);
  const args = ['send', roomId, '--text', 'Remember add', '--request-id', 'first'];
  expect((await command(profile, args, provider)).code).toBe(0);
  expect((await command(profile, args, provider)).code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(
    (
      await command(
        profile,
        ['send', roomId, '--text', 'Which function?', '--request-id', 'second'],
        provider,
      )
    ).code,
  ).toBe(0);
  expect(requests[1]?.messages).toEqual([
    { role: 'system', content: 'Role' },
    { role: 'user', content: 'Remember add' },
    { role: 'assistant', content: 'Hello from bot' },
    { role: 'user', content: 'Which function?' },
  ]);
  expect((await command(profile, ['history', roomId])).result.data).toHaveLength(4);
});
it('TUI restores the same room and sends its next prompt through the common chat service', async () => {
  const { profile, roomId } = await setup();
  const requests: ModelRequest[] = [];
  const provider = model(requests);
  await command(profile, ['send', roomId, '--text', 'Earlier CLI message'], provider);
  const runtime = openOceanProfile(profile);
  await runtime.ready;
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const app = new TuiApp({
    service: runtime.service,
    provider,
    input,
    output,
    book: new ChatRunBook(runtime, roomId, provider),
    size: { columns: 100, rows: 30 },
  });
  try {
    await app.start();
    expect(app.frame()).toContain('Earlier CLI message');
    expect(app.frame()).toContain('Developer');
    input.write('TUI followup\r');
    await app.idle();
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: 'TUI followup' });
    expect(app.frame()).toContain('Hello from bot');
  } finally {
    app.stop();
    await app.idle();
    runtime.close();
  }
  expect((await command(profile, ['history', roomId])).result.data).toHaveLength(4);
});
it('missing provider never commits a fake completion or the submitted prompt', async () => {
  const { profile, roomId } = await setup();
  const missing = await command(profile, ['send', roomId, '--text', 'offline'], null);
  expect(missing.result).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
  expect((await command(profile, ['history', roomId])).result.data).toEqual([]);
});
