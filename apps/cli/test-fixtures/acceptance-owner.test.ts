import { spawn } from 'node:child_process';
import { expect, vi } from 'vitest';

/** Only explicit fixture owners receive a deterministic provider. No inherited credentials. */
export function acceptanceOwner(
  profile: string,
  run: string,
  scenario: string,
  path = process.env['PATH'],
) {
  const cli = ['apps/cli/dist/main.js', 'runtime', 'start', '--profile', profile, '--json'];
  const fixture = ['apps/cli/test-fixtures/local-runtime-turn-owner.test.ts', profile, scenario];
  const drop = ['lost', 'gap'].includes(scenario)
    ? ['--import', './apps/desktop/qa/drop-reply.mjs']
    : [];
  const p = spawn(process.execPath, scenario === 'cli' ? cli : [...drop, ...fixture], {
    env: {
      ...Object.fromEntries(
        [
          'HOME',
          'XDG_RUNTIME_DIR',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME',
          'XDG_CACHE_HOME',
          'TMPDIR',
        ].map((key) => [key, process.env[key]]),
      ),
      PATH: path,
      XDG_RUNTIME_DIR: run,
      OCEAN_TEST_LOG: profile + '/ack',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exit = new Promise((resolve, reject) => {
    p.once('error', reject);
    p.once('close', (code, signal) => resolve(signal ?? code));
  });
  let out = '';
  for (const stream of [p.stdout!, p.stderr!]) {
    stream.on('data', (b: Buffer) => {
      out = (out + b.toString()).slice(-4000);
    });
  }
  const ready = () => vi.waitFor(() => expect(out).toContain('ready'), { timeout: 8000 });
  async function kill() {
    p.kill('SIGKILL');
    return exit;
  }
  return { p, exit, ready, kill };
}
