import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rig, setInput, until } from './model-process-rig.ts';
import { ownFixture } from './model-process-lifecycle.ts';
import { kill } from './model-process-rpc.ts';
export async function cli() {
  const f = await rig();
  let p: ReturnType<typeof spawn> | undefined;
  try {
    const fixture = await f.launch();
    const a = await f.peer();
    await a.client.setModelConnection(setInput);
    const expected = await a.client.listModelConnections();
    await fixture.kill();
    await a.kill();
    const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
    p = spawn(process.execPath, [entry, 'runtime', 'start', '--profile', f.profile, '--json'], {
      env: f.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const owned = p;
    ownFixture(() => kill(owned));
    let output = '';
    for (const stream of [p.stdout!, p.stderr!])
      stream.on('data', (b: Buffer) => {
        output += b.toString();
      });
    await until(
      async () => ({ output, exit: p!.exitCode }),
      (v) => {
        assert.equal(v.exit, null, v.output);
        return v.output.includes('ready');
      },
    );
    const b = await f.peer();
    assert.notEqual(b.info.identity.instanceId, fixture.info.identity.instanceId);
    assert.deepEqual(await b.client.listModelConnections(), expected);
    assert.equal((await b.client.getRoomModelPolicy(f.scope)).policy.revision, 1);
    assert.equal(
      (await b.client.getRunModelExecution({ ...f.scope, runId: f.seed.runs['legacy']! }))
        .execution,
      null,
    );
    return { entry, pid: p.pid, clientPid: b.info.pid, canonicalMetadataPreserved: true };
  } finally {
    if (p) await kill(p);
    await f.close();
  }
}
