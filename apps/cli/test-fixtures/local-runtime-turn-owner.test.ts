// Synthetic owner for native shutdown and detach qualification; launched with an isolated environment.
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { appendFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '@runnets/store-sqlite';
import { once } from 'node:events';
import { TaskRunService, type ProviderPort } from '@runnets/application';
const profile = process.argv[2]!;
const scenario = process.argv[3];
const calls = profile + (scenario === 'successor' ? '/successor.calls' : '/calls');
appendFileSync(calls, '');
if (scenario === 'gap') {
  const execute = TaskRunService.prototype.execute;
  TaskRunService.prototype.execute = async function (command) {
    // Keep the listener responsive at the first aggregate write, after committed chat admission.
    if (command.type === 'CreateTaskRun') await once(process, 'message');
    return execute.call(this, command);
  };
}
const provider: ProviderPort = {
  id: 'test',
  models: ['test'],
  capabilities: { streaming: true, usage: true, reasoning: false },
  stream(request) {
    appendFileSync(calls, 'dispatch\n', { flush: true });
    if (scenario === 'successor') throw Error('unexpected successor provider dispatch');
    return (async function* () {
      request.signal!.addEventListener(
        'abort',
        () => {
          if (process.argv[3]?.startsWith('cancel')) {
            const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
            try {
              const proof = db
                .prepare(
                  "SELECT 1 FROM command_receipts c JOIN events e ON e.aggregate_id=c.aggregate_id AND e.sequence=c.version WHERE c.command_id='room-cancel-stop-one' AND e.type='task_run.cancelling'",
                )
                .get();
              if (proof) writeSync(1, 'receipt-before-abort\n');
            } finally {
              db.close();
            }
          }
          writeSync(1, 'abort\n');
        },
        { once: true },
      );
      if (process.argv[3] === 'claimed') {
        // Synthetic external effect in the listening owner, behind a real durable one-use claim.
        const path = profile + '/runtime.sqlite';
        const db = new DatabaseSync(path, { readOnly: true });
        let taskRunId: string;
        let attemptId: string;
        try {
          const row = db
            .prepare(
              "SELECT aggregate_id,payload FROM events WHERE type='attempt.started' ORDER BY rowid DESC LIMIT 1",
            )
            .get()!;
          taskRunId = String(row['aggregate_id']);
          attemptId = JSON.parse(String(row['payload'])).attemptId;
        } finally {
          db.close();
        }
        const store = openSqliteStore({ path });
        try {
          if (
            !(await store.tools.claim('effect', 'fixture', { taskRunId, attemptId }, 'synthetic'))
          )
            throw Error('duplicate effect');
          appendFileSync(profile + '/effects', 'effect\n', { flush: true });
        } finally {
          store.close();
        }
      }
      const finish = once(process, 'message');
      yield { type: 'text_delta', text: 'native ' } as const;
      const [outcome] = await finish;
      if (outcome !== 'success') throw Error('synthetic stream failure');
      yield { type: 'text_delta', text: 'fixture answer' } as const;
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as const;
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' } as const;
    })();
  },
};
const host = await startLocalRuntime({
  profile,
  provider,
  drainDeadlineMs: process.argv[3] === 'draining_retry' ? 25_000 : 300,
});
writeSync(1, 'ready\n');
await host.closed;
