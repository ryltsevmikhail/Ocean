import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const [profile, encoded, role, mode] = process.argv.slice(2) as [string, string, string, string];
const ref = JSON.parse(encoded);
const client = await connectLocalRuntime({ profile });
try {
  const card = await client.getDecision(ref);
  const preview = await client.decisionPreview(ref);
  // Neither voter can act until both processes have read the complete pending operation.
  writeFileSync(join(profile, 'voter-' + role), '');
  const other = join(profile, 'voter-' + (role === 'one' ? 'two' : 'one'));
  while (!existsSync(other)) await setTimeout(10);
  if (mode === 'expired') writeFileSync(join(profile, 'expired'), '');
  const vote = { ...ref, expectedVersion: card.version, bindingDigest: card.bindingDigest };
  const winner = await client.resolveDecision({ ...vote, choice: 'allow-once' });
  const stale = await client.resolveDecision({ ...vote, choice: 'deny' });
  const persisted = await client.getDecision(ref);
  console.log(JSON.stringify({ card, preview, winner, stale, persisted }));
} finally {
  client.close();
}
