// Read-only independent client: no SQLite access, writes, discovery or retries.
import process from 'node:process';
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
const [profile, after] = process.argv.slice(2);
if (!profile)
  throw Error('usage: node examples/local-service-owner-read.mjs /absolute/profile [after]');
const client = await connectLocalRuntime({ profile });
try {
  const connections = await client.serviceConnections();
  const grants = await client.serviceGrants();
  const operations = await client.listServiceOwnerOperations({
    limit: 50,
    ...(after ? { after } : {}),
  });
  const receipt = operations.items[0]
    ? await client.serviceReceipt({ requestId: operations.items[0].requestId })
    : null;
  process.stdout.write(
    JSON.stringify({ connections, grants, operations, receipt }, null, 2) + '\n',
  );
} finally {
  client.close();
}
