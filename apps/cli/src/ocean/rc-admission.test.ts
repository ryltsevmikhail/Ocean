import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runOceanCommand } from './command.js';
import { ownSqliteRuntime } from '@runnets/store-sqlite';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
async function call(profile: string, args: string[]) {
  const output = new PassThrough();
  let text = '';
  output.on('data', (b: Buffer) => {
    text += b.toString();
  });
  const code = await runOceanCommand([...args, '--profile', profile, '--json'], {
    output,
    error: new PassThrough(),
  });
  return { code, reply: JSON.parse(text) };
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ocean-rc-admission-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  await call(profile, ['init', '--workspace', root]);
  return { root, profile };
}
it('reports a second live owner as owner_busy, not invalid_input', async () => {
  const { profile } = await setup(),
    release = ownSqliteRuntime(join(profile, 'runtime.sqlite'));
  try {
    const result = await call(profile, ['room', 'list']);
    expect(result.code).toBe(3);
    expect(result.reply.error.code).toBe('owner_busy');
  } finally {
    release();
  }
});
it('rejects a hardlinked profile database before runtime recovery', async () => {
  const { root, profile } = await setup();
  linkSync(join(profile, 'runtime.sqlite'), join(root, 'database-link'));
  const result = await call(profile, ['room', 'list']);
  expect(result.reply.error.code).toBe('insecure_permissions');
});
