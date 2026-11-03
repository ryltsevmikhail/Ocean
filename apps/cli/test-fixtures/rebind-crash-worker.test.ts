// Real restored-owner rebind owner; halts at a named durable boundary for the parent SIGKILL.
import { mkdirSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openSqliteStore, readProfileRestoreSnapshot } from '@runnets/store-sqlite';
import { ProfileRebindService, RuntimeOwnerDecisions } from '@runnets/application';
import {
  GitCodingApplyProject,
  RestoredProfileFiles,
  SqliteProjectLeases,
} from '@runnets/tools-node';
const [profile, selected, phase] = process.argv.slice(2) as [string, string, string];
function halt(at: string): never {
  writeSync(1, at + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw Error('halted');
}
const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
const origin = store.restoration.origin();
const task = store.coding.atomic((tx) => tx.task('task'));
if (!origin || !task) throw Error('fixture_state');
const treeHash = await new GitCodingApplyProject().tree(selected, task.baseCommit);
const owner = new RuntimeOwnerDecisions(store.ownerDecisions, Date.now);
const real = new RestoredProfileFiles(profile, readProfileRestoreSnapshot);
const files = {
  inspect: (input: Parameters<typeof real.inspect>[0]) => real.inspect(input),
  diagnose: (
    originValue: Parameters<typeof real.diagnose>[0],
    taskValue: Parameters<typeof real.diagnose>[1],
    root: string,
  ) => real.diagnose(originValue, taskValue, root),
  prepare: async (record: Parameters<typeof real.prepare>[0]) => {
    if (phase === 'preparing' || phase === 'preparing-unsafe') {
      const plan = record.preview.plan;
      mkdirSync(plan.managedDirectory, { recursive: true, mode: 0o700 });
      if (phase === 'preparing')
        writeFileSync(join(plan.managedDirectory, 'partial.txt'), 'partial materialization\n', {
          mode: 0o600,
        });
      else symlinkSync('missing-slot', join(plan.managedDirectory, 'workspace'));
      halt('preparing');
    }
    return real.prepare(record);
  },
  verify: (preview: Parameters<typeof real.verify>[0], result: Parameters<typeof real.verify>[1]) =>
    real.verify(preview, result),
};
const registry = new SqliteProjectLeases();
const leases = {
  acquire: (root: string, holder: Parameters<typeof registry.acquire>[1]) => {
    if (phase === 'decision') halt('decision');
    const result = registry.acquire(root, holder);
    if (phase === 'acquired') halt('acquired');
    return result;
  },
  owns: (lease: Parameters<typeof registry.owns>[0]) => registry.owns(lease),
  release: (lease: Parameters<typeof registry.release>[0]) => registry.release(lease),
};
const atomic: typeof store.rebind.atomic = (work) => {
  const value = store.rebind.atomic((tx) =>
    work({
      ...tx,
      publish: (record, result) => {
        if (phase === 'publishing') halt('publishing');
        tx.publish(record, result);
      },
    }),
  );
  if (phase === 'published' && store.rebind.active()) halt('published');
  return value;
};
const rebindStore = {
  active: () => store.rebind.active(),
  recover: () => store.rebind.recover(),
  atomic,
};
const service = new ProfileRebindService({
  store: rebindStore,
  files,
  leases,
  owner,
  now: Date.now,
  nextId: randomUUID,
  digest: (text: string) => createHash('sha256').update(text).digest('hex'),
});
const selection = {
  requestId: 'crash-rebind',
  workspaceId: task.workspaceId,
  roomId: task.ownerRoomId,
  profileId: origin.profileId,
  snapshotId: origin.snapshotId,
  sourceOwnerId: task.lease.ownerId,
  taskId: task.id,
  projectRoot: selected,
  baseCommit: task.baseCommit,
  treeHash,
  policy: task.policy,
};
const card = await service.preview(selection);
if (phase === 'intent') halt('intent');
await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
await service.join();
writeSync(1, 'completed\n');
store.close();
process.exit(0);
