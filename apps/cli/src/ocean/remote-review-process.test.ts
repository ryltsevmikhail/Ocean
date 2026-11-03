import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { openOceanProfile } from './profile.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { runOceanCommand } from './command.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { profileCli } from '../../test-fixtures/profile-cli.test.js';
it('requires an exact interactive server card and verifies the committed continuation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-vote-')),
    profile = join(root, 'p'),
    run = join(root, 'r');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const r = openOceanProfile(profile, true);
  await r.ready;
  const { workspaceId, roomId } = rooms(r.conversations);
  const result = await r.chat.send({
    workspaceId,
    roomId,
    requestId: 'send',
    text: 'task',
    signal: new AbortController().signal,
    emit: () => {},
    provider: {
      id: 'test',
      models: ['test'],
      capabilities: { streaming: true, reasoning: false, usage: true },
      async *stream() {
        yield { type: 'text_delta', text: 'partial' };
      },
    },
  });
  if (!result.ok || !result.value.taskRunId) throw Error('fixture send');
  const id = result.value.taskRunId;
  r.close();
  const host = await startLocalRuntime({ profile, provider: null }),
    cli = profileCli(profile, run);
  try {
    const view = (await cli('run', 'review', id)).reply.data;
    expect(view).toMatchObject({ canAcknowledge: true, roomId, runId: id });
    const args = [
      'run',
      'acknowledge',
      id,
      '--text-only',
      '--review-version',
      view.version,
      '--reason',
      'reason\x1b[31m',
      '--request-id',
      'vote',
      '--profile',
      profile,
      '--json',
    ];
    const yes = vi.fn(() => Promise.resolve(true)),
      input = new PassThrough();
    input.end('y\n');
    expect(
      await runOceanCommand(args, {
        input,
        output: new PassThrough(),
        error: new PassThrough(),
        reviewApproval: { confirm: yes },
      }),
    ).toBe(4);
    expect(yes).not.toHaveBeenCalled();
    const program = `import os,pty,subprocess,sys,select
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stderr=slave,stdout=subprocess.PIPE)
os.close(slave)
preview=b''
while b'[y/N]' not in preview:
 if not select.select([master],[],[],4)[0]: raise RuntimeError('missing preview')
 preview+=os.read(master,8192)
os.write(master,b'y\\n')
print(p.communicate(timeout=5)[0].decode())
print(preview.decode())
sys.exit(p.returncode)`;
    const proc = spawn(
      '/usr/bin/python3',
      ['-c', program, process.execPath, resolve('apps/cli/dist/main.js'), ...args],
      { env: { XDG_RUNTIME_DIR: run } },
    );
    let out = '',
      err = '';
    proc.stdout.on('data', (b) => {
      out += b;
    });
    proc.stderr.on('data', (b) => {
      err += b;
    });
    expect(await new Promise((r) => proc.once('close', r)), err).toBe(0);
    expect(out).toContain('reason\\u001b[31m');
    expect(out).toContain(view.version);
    expect(out).not.toContain('\x1b[31m');
    expect(JSON.parse(out.split('\n')[0]!)).toMatchObject({
      data: { continuationApplied: true, status: 'allowed' },
    });
    expect((await cli('run', 'review', id)).reply.data.mode).toBe('text_only');
  } finally {
    await host.stop();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
