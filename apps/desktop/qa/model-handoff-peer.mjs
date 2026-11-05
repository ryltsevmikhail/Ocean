// A distinct process imports the accepted installed SDK public export, never workspace dist.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
const [installed, profile, action, encoded] = process.argv.slice(2);
const pkg = join(installed, 'node_modules/@runnets/tools-node');
const entry = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).exports[
  './local-runtime-client'
].import;
const sdk = join(pkg, entry);
assert.equal(realpathSync(sdk), sdk);
const { connectLocalRuntime } = await import(pathToFileURL(sdk));
const peer = await connectLocalRuntime({ profile });
try {
  const query = JSON.parse(encoded);
  const data =
    action === 'replay'
      ? await peer.submit(query)
      : {
          status: await peer.status(),
          run: await peer.getRun(query),
          result: await peer.getResult(query),
          history: await peer.history({ workspaceId: query.workspaceId, roomId: query.roomId }),
          execution: await peer.getRunModelExecution(query),
        };
  process.stdout.write(JSON.stringify({ pid: process.pid, sdk, data }) + '\n');
} finally {
  peer.close();
}
