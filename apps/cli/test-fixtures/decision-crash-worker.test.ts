// Halt the real owner at a named commit boundary for the parent SIGKILL.
import { writeSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { WorkspaceTools } from '@runnets/tools-node';
import { openSqliteStore } from '@runnets/store-sqlite';
import type { ProviderPort, ToolJournalPort } from '@runnets/application';
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
let round = 0;
const provider: ProviderPort = {
  id: 'fixture',
  models: ['fixture'],
  capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
  async *stream() {
    appendFileSync(join(profile, 'calls'), 'provider\n', { flush: true });
    if (round >= 2 && (phase === 'vote' || phase === 'expired')) {
      yield { type: 'text_delta', text: 'finished' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      return;
    }
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
if (phase === 'expired') {
  // Advance only this owner's decision clock, once both voters hold the unexpired card.
  const now = Date.now;
  Date.now = () => now() + (existsSync(join(profile, 'expired')) ? 300001 : 0);
}
if (phase === 'vote' || phase === 'expired') {
  const prepare = WorkspaceTools.prototype.prepare;
  WorkspaceTools.prototype.prepare = async function (call) {
    const prepared = await prepare.call(this, call);
    if (prepared.kind !== 'edit') return prepared;
    return {
      ...prepared,
      execute(signal) {
        appendFileSync(join(profile, 'effects'), 'write\n', { flush: true });
        return prepared.execute(signal);
      },
    };
  };
}
if (phase === 'effect') {
  const store = openSqliteStore({ path: ':memory:' });
  const journal = Object.getPrototypeOf(store.tools) as ToolJournalPort;
  store.close();
  const settle = journal.settle;
  journal.settle = async function (...args) {
    if (args[0].endsWith('_write')) {
      appendFileSync(join(profile, 'effects'), 'write\n', { flush: true });
      halt('effect');
    }
    return settle.apply(this, args);
  };
}
if (['effect', 'vote', 'expired'].includes(phase)) {
  const host = await startLocalRuntime({ profile, provider });
  writeSync(1, 'ready\n');
  await host.closed;
  process.exit(0);
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
