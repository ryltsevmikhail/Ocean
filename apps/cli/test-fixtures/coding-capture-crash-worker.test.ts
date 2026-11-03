// Halt the real changeset capture at a named durable boundary for the parent SIGKILL.
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { CodingTask, WorktreeBinding } from '@runnets/domain';
const [profile, roomId, phase] = process.argv.slice(2) as [string, string, string];
const halt = (at: string): never => {
  writeSync(1, at + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw Error('halt returned');
};
// Test-only observation seam: the immutable artifact INSERT runs inside the capture transaction.
// Killing after it proves SQLite never publishes the artifact without its capture receipt.
if (phase === 'artifact') {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (/INSERT INTO ocean_changesets/.test(sql)) {
      const run = statement.run.bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as { run: (...args: unknown[]) => unknown }).run = (
        ...args: unknown[]
      ) => {
        const result = run(...args);
        halt('artifact');
        return result;
      };
    }
    return statement;
  };
}
const { GitCodingSnapshots } = await import('@runnets/tools-node');
if (phase === 'scan') {
  // The product scan completed in memory but no store transaction has begun yet.
  const prototype = GitCodingSnapshots.prototype;
  const capture = prototype.capture;
  prototype.capture = async function (
    this: InstanceType<typeof GitCodingSnapshots>,
    task: CodingTask,
    binding: WorktreeBinding,
  ) {
    const artifact = await capture.call(this, task, binding);
    halt('scan');
    return artifact;
  };
}
const { openOceanProfile } = await import('../dist/ocean/profile.js');
const runtime = openOceanProfile(profile, false);
try {
  await runtime.ready;
  const inspected = runtime.coding.inspect('ws_ocean', 'task');
  if (!inspected.ok) throw Error('fixture task');
  const task = inspected.value;
  const captured = await runtime.codingChanges.capture(
    {
      workspaceId: 'ws_ocean',
      taskId: 'task',
      roomId,
      botId: task.devBotId,
      policyVersion: task.policyVersion,
      capability: 'project_read',
    },
    'crash-request',
  );
  if (!captured.ok) throw Error('fixture capture ' + captured.error.code);
  if (phase === 'committed') halt('committed');
  writeSync(1, 'done\n');
} finally {
  runtime.close();
}
