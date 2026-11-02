// Real application owner without a listener. Halt at a named commit boundary for the parent SIGKILL.
import { writeSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderPort } from '@runnets/application';
import { openOceanProfile } from '../dist/ocean/profile.js';
import { registeredCodingTools } from '../dist/ocean/coding-project-host.js';
import { RuntimeDecisions } from '../dist/local-runtime/decisions.js';
const [profile, roomId, phase] = process.argv.slice(2) as [string, string, string];
function halt(at: string) {
  if (at === phase) {
    writeSync(1, at + '\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}
const r = openOceanProfile(profile, false, {
  codingTools: { ...registeredCodingTools(profile), owner: (t, s) => d.coding(t, s) },
});
await r.ready;
const d = new RuntimeDecisions(r.ownerDecisions, r.reviews);
const store = r.ownerDecisions;
const insert = store.insert.bind(store),
  settle = store.settle.bind(store);
store.insert = (card, preview) => {
  insert(card, preview);
  halt('pending');
  queueMicrotask(() => {
    void d.owner.resolve(card, card.bindingDigest, 1, 'allow-once');
  });
};
store.settle = (card, status) => {
  const won = settle(card, status);
  if (won) halt('winner');
  return won;
};
const approvals = r.codingApprovals;
const decide = approvals.decide.bind(approvals),
  consume = approvals.consume.bind(approvals);
approvals.decide = async (...args) => {
  const decision = await decide(...args);
  if (decision.ok && decision.value.status === 'allowed') halt('allowed');
  return decision;
};
approvals.consume = (...args) => {
  const grant = consume(...args);
  if (grant.ok) halt('claim');
  return grant;
};
const journal = r.toolJournal!,
  settleEffect = journal.settle.bind(journal);
journal.settle = async (...args) => {
  if (args[0].endsWith('_write')) {
    appendFileSync(join(profile, 'effects'), 'write\n', { flush: true });
    halt('effect');
  }
  return settleEffect(...args);
};
let round = 0;
const provider: ProviderPort = {
  id: 'fixture',
  models: ['fixture'],
  capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
  async *stream() {
    appendFileSync(join(profile, 'calls'), 'provider\n', { flush: true });
    const call =
      round++ === 0
        ? { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' }
        : {
            id: 'write',
            name: 'write_file',
            arguments: '{"path":"math.cjs","content":"crash fixture"}',
          };
    yield { type: 'tool_call', call };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
  },
};
try {
  await r.chat.send({
    workspaceId: 'ws_ocean',
    roomId,
    requestId: 'crash',
    taskId: 'task',
    provider,
    text: 'synthetic',
    signal: new AbortController().signal,
    emit: () => {},
  });
} finally {
  r.close();
}
