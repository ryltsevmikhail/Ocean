// Independent process: only the installed public SDK, authenticated ordinary owner reads.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
const [installed, profile, encoded] = process.argv.slice(2);
const pkg = join(installed, 'node_modules/@runnets/tools-node');
const sdk = join(
  pkg,
  JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).exports['./local-runtime-client']
    .import,
);
assert.equal(realpathSync(sdk), sdk);
const { connectLocalRuntime } = await import(pathToFileURL(sdk));
const peer = await connectLocalRuntime({ profile });
try {
  const query = JSON.parse(encoded),
    scope = { workspaceId: query.workspaceId, roomId: query.roomId };
  const root = await peer.roomTaskGet(query),
    runs = [];
  for (const row of root.rows.filter((r) => r.type === 'slice')) {
    const q = { ...scope, runId: row.runId };
    runs.push({
      run: await peer.getRun(q),
      result: await peer.getResult(q),
      execution: await peer.getRunModelExecution(q),
    });
  }
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      sdk,
      identity: peer.identity,
      root,
      runs,
      history: await peer.history(scope),
      decisions: await peer.listDecisions(scope),
    }) + '\n',
  );
} finally {
  peer.close();
}
