import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ProviderPort } from '@runnets/application';
import { runOceanCommand } from './command.js';
import { openOceanProfile } from './profile.js';
import { TuiApp } from '../tui/app.js';
import { ChatRunBook } from './chat-book.js';
const folders: string[] = [];
afterEach(() => {
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-owner-review-'));
  folders.push(root);
  const profile = join(root, 'profile');
  const broken: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream() {
      yield { type: 'text_delta', text: 'partial' };
    },
  };
  async function command(args: readonly string[]) {
    const output = new PassThrough();
    const error = new PassThrough();
    let text = '';
    output.on('data', (b: Buffer) => {
      text += b.toString();
    });
    const code = await runOceanCommand([...args, '--profile', profile, '--json'], {
      provider: broken,
      output,
      error,
      input: new PassThrough(),
    });
    return { code, data: JSON.parse(text) };
  }
  await command(['init', '--workspace', root]);
  await command([
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
  ]);
  const room = (await command(['room', 'direct', '--bot', 'dev'])).data.data.data.id as string;
  const sent = await command(['send', room, '--text', 'Interrupted prompt']);
  return { profile, room, id: sent.data.data.taskRunId as string, command, broken };
}
it('CLI shows interrupted state and refuses acknowledge from redirected stdin', async () => {
  const c = await setup();
  const reviewed = await c.command(['run', 'review', c.id]);
  expect(reviewed.data.data).toMatchObject({ turnStatus: 'uncertain', canAcknowledge: true });
  expect((await c.command(['run', 'list'])).data.data).toHaveLength(1);
  const denied = await c.command([
    'run',
    'acknowledge',
    c.id,
    '--text-only',
    '--review-version',
    reviewed.data.data.version,
    '--reason',
    'Checked',
  ]);
  expect(denied.code).toBe(4);
  expect(denied.data).toMatchObject({ ok: false, error: { code: 'approval_required' } });
  expect((await c.command(['run', 'show', c.id])).data.data.canAcknowledge).toBe(true);
});
it('TUI owner confirms the viewed run once, and the persisted mode survives reopening', async () => {
  const c = await setup();
  const runtime = openOceanProfile(c.profile);
  await runtime.ready;
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (_mode: boolean) => {},
  });
  const output = new PassThrough();
  output.resume();
  const app = new TuiApp({
    input,
    output,
    book: new ChatRunBook(runtime, c.room, c.broken),
  });
  try {
    await app.start();
    input.write('/review\r');
    await app.idle();
    expect(app.frame()).toContain('Interrupted run review');
    let reached: () => void = () => {};
    const pending = new Promise<void>((r) => {
      reached = r;
    });
    output.on('data', (b: Buffer) => {
      if (b.toString().includes('Permission: Continue text-only')) reached();
    });
    input.write('/continue text-only Inspected the interruption\r');
    await pending;
    input.write('a');
    expect(app.frame()).toContain('Permission: Continue text-only');
    input.write('y');
    await app.idle();
    expect(app.frame()).toContain('text-only');
  } finally {
    app.stop();
    await app.idle();
    runtime.close();
  }
  const after = await c.command(['run', 'show', c.id]);
  expect(after.data.data).toMatchObject({
    turnStatus: 'uncertain',
    canAcknowledge: false,
    mode: 'text_only',
  });
  expect((await c.command(['history', c.room])).data.data).toHaveLength(2);
});
