// A second independent public-client process; it never resends an unknown mutation.
import process from 'node:process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
const [profile, action, file] = process.argv.slice(2);
const client = await connectLocalRuntime({ profile });
try {
  const input = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const value =
    action === 'operations'
      ? await client.listServiceOwnerOperations({ state: 'prepared' })
      : action === 'receipt'
        ? await client.serviceReceipt(input)
        : action === 'decision'
          ? { card: await client.getDecision(input), preview: await client.decisionPreview(input) }
          : action === 'resolve'
            ? await client.resolveDecision(input)
            : {
                connections: await client.serviceConnections(),
                grants: await client.serviceGrants(),
              };
  console.log(JSON.stringify(value));
} finally {
  client.close();
}
