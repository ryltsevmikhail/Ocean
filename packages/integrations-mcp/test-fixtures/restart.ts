import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpServiceTransport } from '@runnets/integrations-mcp';
import { connection } from './admission.ts';
const [dir, state] = process.argv.slice(2);
assert.ok(dir && state);
const run = join(dir, 'kill'),
  file = join(dir, 'fault.mjs');
const cfg = connection({
  kind: 'stdio',
  executable: file,
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  args: ['/workspace'],
});
const t = createMcpServiceTransport({
  stdio: { profileRoot: join(run, 'profile'), workspaces: { connection: join(run, 'workspace') } },
});
try {
  const discover = () =>
    t.discover(cfg, {
      signal: new AbortController().signal,
      deadlineMs: 8000,
      authorizeMetadata: () => true,
    });
  if (state === 'occupied') await assert.rejects(discover);
  else assert.ok((await discover()).tools.some((t) => t.name === 'write'));
} finally {
  const cleanup = await t.close();
  assert.notEqual(cleanup.status, 'unknown');
}
console.log('restart', state, 'ok');
