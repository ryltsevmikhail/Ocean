import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ModelRequest, ProviderPort } from '@runnets/application';
import { runOceanCommand } from './command.js';
import { openOceanProfile } from './profile.js';
import { ChatRunBook } from './chat-book.js';
import { TuiApp } from '../tui/app.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
it('creates and lists a group, hands off CLI→TUI and preserves private-room isolation after reopening', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-group-cli-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const requests: ModelRequest[] = [];
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'Reply with @review as data' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  async function command(args: readonly string[], p: ProviderPort | null = provider) {
    const output = new PassThrough();
    const error = new PassThrough();
    let text = '';
    output.on('data', (b: Buffer) => {
      text += b.toString();
    });
    const code = await runOceanCommand([...args, '--profile', profile, '--json'], {
      output,
      error,
      provider: p,
    });
    return { code, data: JSON.parse(text) };
  }
  expect((await command(['init', '--workspace', root])).code).toBe(0);
  for (const handle of ['dev', 'review'])
    expect(
      (
        await command([
          'bot',
          'add',
          '--handle',
          handle,
          '--name',
          handle.toUpperCase(),
          '--role',
          'Role ' + handle,
          '--provider',
          'test',
          '--model',
          'test',
        ])
      ).code,
    ).toBe(0);
  const direct = (await command(['room', 'direct', '--bot', 'review'])).data.data.data.id as string;
  expect((await command(['send', direct, '--text', 'Private review history'])).code).toBe(0);
  const group = await command([
    'room',
    'group',
    '--name',
    'Team',
    '--bot',
    'dev',
    '--bot',
    'review',
  ]);
  expect(group.code).toBe(0);
  const roomId = group.data.data.data.id as string;
  expect(
    (await command(['room', 'members', roomId])).data.data
      .map((b: { handle: string }) => b.handle)
      .sort(),
  ).toEqual(['dev', 'review']);
  expect((await command(['room', 'list'])).data.data).toHaveLength(2);
  const before = requests.length;
  expect((await command(['send', roomId, '--text', 'Shared note'], null)).data.data.status).toBe(
    'recorded',
  );
  expect(requests).toHaveLength(before);
  expect((await command(['send', roomId, '--to', 'dev', '--text', 'Implement add'])).code).toBe(0);
  expect(requests).toHaveLength(before + 1);
  expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('Private review history');
  const runtime = openOceanProfile(profile);
  await runtime.ready;
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const app = new TuiApp({
    input,
    output,
    book: new ChatRunBook(runtime, roomId, provider),
  });
  try {
    await app.start();
    expect(app.frame()).toContain('DEV');
    input.write('@review inspect result\r');
    await app.idle();
    expect(requests).toHaveLength(before + 2);
    expect(app.frame()).toContain('REVIEW');
    const last = requests.at(-1)?.messages ?? [];
    expect(last[0]?.content).toContain('Role review');
    expect(JSON.stringify(last)).toContain('Reply with @review as data');
    expect(JSON.stringify(last)).not.toContain('Private review history');
  } finally {
    app.stop();
    await app.idle();
    runtime.close();
  }
  const history = (await command(['history', roomId])).data.data as {
    seq: number;
    author: string;
  }[];
  expect(history.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(history.filter((m) => m.author === 'bot')).toHaveLength(2);
});
