import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { rig, until } from './model-process-rig.ts';
import { ownFixture } from './model-process-lifecycle.ts';
import { kill } from './model-process-rpc.ts';
/** Deliberately remains live until the supervising launcher times it out. */
export async function timeout() {
  const f = await rig();
  const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const p = spawn(process.execPath, [entry, 'runtime', 'start', '--profile', f.profile, '--json'], {
    env: f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownFixture(() => kill(p));
  try {
    let output = '';
    for (const stream of [p.stdout!, p.stderr!])
      stream.on('data', (b: Buffer) => {
        output += b.toString();
      });
    await until(
      async () => ({ output, exit: p.exitCode }),
      (v) => {
        assert.equal(v.exit, null, 'timeout listener exited during setup');
        return v.output.includes('ready');
      },
    );
    const peer = await f.peer();
    assert.equal((await peer.client.status()).state, 'ready');
    const ready = { pids: [p.pid!, peer.info.pid], endpoint: peer.info.endpoint };
    writeFileSync(process.argv[3]! + '/timeout-ready.json', JSON.stringify(ready), { mode: 0o600 });
    process.send?.({ ready });
    await new Promise(() => {});
  } finally {
    await kill(p);
    await f.close();
  }
}
