import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeOwnerDecisions } from '@runnets/application';
import * as stores from '@runnets/store-sqlite';
import * as adapters from '@runnets/tools-node';
import type { CodingTask } from '@runnets/domain';
import { connectLocalRuntime, type LocalRuntimeClient } from '@runnets/tools-node';
import { startLocalRuntime, type LocalRuntimeHost } from '../local-runtime/host.js';
import { backupProfile, restoreProfile } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { createRuntime } from '../runtime.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
const hosts: LocalRuntimeHost[] = [];
const clients: LocalRuntimeClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0).reverse()) {
    const stopped = await h.stop();
    if (stopped.outcome === 'complete') await h.closed;
  }
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.unstubAllEnvs();
});
function root(prefix: string) {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix)),
    home = join(dir, 'home'),
    run = join(dir, 'run');
  for (const path of [home, run]) fs.mkdirSync(path, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function clone(source: string, target: string) {
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', source, target], {
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}
async function stopHost(host: LocalRuntimeHost) {
  const stopped = await host.stop();
  if (stopped.outcome === 'complete') await host.closed;
}
async function confirmation(
  client: LocalRuntimeClient,
  task: CodingTask,
  requestId: string,
  projectRoot: string,
) {
  const inspection = await client.inspectRestore({
    requestId,
    workspaceId: 'ws_ocean',
    roomId: task.ownerRoomId,
    taskId: task.id,
    projectRoot,
    policy: task.policy,
  });
  return { inspection, card: await client.previewRestore(inspection.selection) };
}
async function resolve(
  client: LocalRuntimeClient,
  card: Awaited<ReturnType<LocalRuntimeClient['previewRestore']>>,
) {
  await client.resolveDecision({
    workspaceId: card.workspaceId,
    roomId: card.roomId,
    runId: card.runId,
    decisionId: card.decisionId,
    bindingDigest: card.bindingDigest,
    choice: 'allow-once',
    expectedVersion: card.version,
  });
}
async function ready(
  client: LocalRuntimeClient,
  selection: Parameters<LocalRuntimeClient['restoreResult']>[0],
) {
  let result = await client.restoreResult(selection);
  const deadline = Date.now() + 30000;
  while (!['ready', 'held', 'refused'].includes(result.state) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
    result = await client.restoreResult(selection);
  }
  expect(result.state, result.reason ?? '').toBe('ready');
  return result;
}
it('performs a second owner-confirmed rebind through the bounded parent chain after source deletion', async () => {
  const dir = root('second-generation-');
  const f = await codingWorkflowFixture('direct');
  cleanups.push(() => f.close());
  const selected1 = join(dir, 'selected-1');
  clone(f.project, selected1);
  fs.writeFileSync(join(f.worktree, 'answer.txt'), 'gen0 archived ready-tree\n');
  await f.capture('gen0');
  fs.writeFileSync(join(f.worktree, 'answer.txt'), 'gen0 post-capture tree\n');
  f.runtime.close();
  fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const frozen = (() => {
    const store = stores.openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
    try {
      return structuredClone(store.coding.atomic((tx) => tx.task('task'))!);
    } finally {
      store.close();
    }
  })();
  const gen0Task = frozen;
  fs.writeFileSync(
    join(f.directory, 'coding-projects.json'),
    JSON.stringify([
      { id: 'project', root: f.project, testPresets: gen0Task.policy.testPresets, mounts: [] },
    ]),
    { mode: 0o600 },
  );
  const archive1 = join(dir, 'archive-1');
  await backupProfile(f.directory, archive1, { managedDirectory: join(f.directory, 'worktrees') });
  // First generation: genuine quarantine, owner confirmation and ready publication.
  fs.rmSync(f.directory, { recursive: true, force: true });
  const first = join(dir, 'profile-1');
  restoreProfile(archive1, first);
  fs.rmSync(archive1, { recursive: true });
  const firstHost = await startLocalRuntime({ profile: first, restore: true, provider: null });
  hosts.push(firstHost);
  const firstClient = await connectLocalRuntime({ profile: first });
  clients.push(firstClient);
  const firstConfirmed = await confirmation(firstClient, gen0Task, 'rebind-1', selected1);
  await resolve(firstClient, firstConfirmed.card);
  const firstResult = await ready(firstClient, firstConfirmed.inspection.selection);
  const firstPreview = JSON.parse(
    await firstClient.decisionPreview({
      workspaceId: firstConfirmed.card.workspaceId,
      roomId: firstConfirmed.card.roomId,
      runId: firstConfirmed.card.runId,
      decisionId: firstConfirmed.card.decisionId,
    }),
  ) as { plan: { worktree: { root: string } } };
  await stopHost(firstHost);
  hosts.splice(hosts.indexOf(firstHost), 1);
  // Fresh live work under the new epoch, then a fresh public format-2 backup with lineage.
  const successor = firstResult.successorTaskId;
  fs.writeFileSync(join(firstPreview.plan.worktree.root, 'answer.txt'), 'gen1 live tree\n');
  const archive2 = join(dir, 'archive-2');
  const secondManifest = await backupProfile(first, archive2);
  const graph = adapters.verifyProfileLineageGraph(archive2, stores.readProfileRestoreSnapshot);
  const depth = (node: typeof graph | null): number => (node ? 1 + depth(node.parent) : 0);
  expect(depth(graph)).toBe(2);
  const sources = Object.fromEntries(
    graph.manifest.lineage!.tasks.map((task) => [task.taskId, task.source]),
  );
  expect(sources).toEqual({ [gen0Task.id]: 'parent', [successor]: 'live' });
  const gen0Tree = graph.parent!.catalog.worktrees.worktrees.find(
    (tree) => tree.taskId === gen0Task.id,
  )!;
  expect(gen0Tree.treeHash).toBeTruthy();
  const savedFirstRecord = (() => {
    const store = stores.openSqliteStore({ path: join(first, 'runtime.sqlite') });
    try {
      return structuredClone(store.rebind.atomic((tx) => tx.record('rebind-1'))!);
    } finally {
      store.close();
    }
  })();
  expect(savedFirstRecord.state).toBe('ready');
  // The second owner-selected project is an independent clone at the exact archived base.
  const selected2 = join(dir, 'selected-2');
  clone(selected1, selected2);
  fs.rmSync(first, { recursive: true });
  fs.rmSync(selected1, { recursive: true });
  const second = join(dir, 'profile-2');
  expect(restoreProfile(archive2, second)).toEqual(secondManifest);
  fs.rmSync(archive2, { recursive: true });
  const restored = stores.readCodingBackupInventory(join(second, 'runtime.sqlite'));
  expect(restored.tasks.map((t) => t.id).sort()).toEqual([gen0Task.id, successor].sort());
  const secondHost = await startLocalRuntime({ profile: second, restore: true, provider: null });
  hosts.push(secondHost);
  const secondClient = await connectLocalRuntime({ profile: second });
  clients.push(secondClient);
  const selected = await confirmation(secondClient, gen0Task, 'rebind-2', selected2);
  const preview = JSON.parse(
    await secondClient.decisionPreview({
      workspaceId: selected.card.workspaceId,
      roomId: selected.card.roomId,
      runId: selected.card.runId,
      decisionId: selected.card.decisionId,
    }),
  ) as {
    originalTask: { id: string };
    plan: { treeHash: string; changesetHashes: string[] };
    epochId: string;
  };
  expect(preview.originalTask.id).toBe(gen0Task.id);
  expect(preview.plan.treeHash).toBe(gen0Tree.treeHash);
  expect(preview.plan.changesetHashes).toContain(
    graph.parent!.catalog.inventory.changesets.find((c) => c.taskId === gen0Task.id)!.hash,
  );
  await resolve(secondClient, selected.card);
  const secondResult = await ready(secondClient, selected.inspection.selection);
  expect(secondResult.epochId).not.toBe(firstResult.epochId);
  expect(secondResult.successorTaskId).not.toBe(successor);
  await stopHost(secondHost);
  hosts.splice(hosts.indexOf(secondHost), 1);
  const store = stores.openSqliteStore({ path: join(second, 'runtime.sqlite') });
  try {
    const active = store.rebind.active()!;
    expect(active.requestId).toBe('rebind-2');
    expect(active.preview.epochId).toBe(secondResult.epochId);
    expect(active.preview.ownerId).toBe(
      active.preview.origin.profileId + ':' + active.preview.epochId,
    );
    expect(active.result!.task.id).toBe(secondResult.successorTaskId);
    expect(active.preview.plan.treeHash).toBe(gen0Tree.treeHash);
    expect(fs.readFileSync(join(active.result!.worktree.root, 'answer.txt'), 'utf8')).toBe(
      'gen0 post-capture tree\n',
    );
    await new adapters.GitCodingWorktrees(active.preview.plan.managedDirectory).verify(
      active.result!.task,
      active.result!.worktree,
    );
    // Every archived authority record is preserved exactly and can never become current again.
    expect(store.rebind.atomic((tx) => tx.record('rebind-1'))).toEqual(savedFirstRecord);
    const archivedDecision = store.ownerDecisions.find({
      workspaceId: savedFirstRecord.preview.selection.workspaceId,
      roomId: savedFirstRecord.preview.selection.roomId,
      runId: 'rebind-' + savedFirstRecord.preview.epochId,
      decisionId: savedFirstRecord.decisionId,
    });
    expect(archivedDecision).toMatchObject({ status: 'allowed', version: 2 });
    const cardinality = store.rebind.atomic((tx) => ({
      task0: tx.task(gen0Task.id),
      successor: tx.task(successor),
      current: tx.task(secondResult.successorTaskId),
    }));
    expect(cardinality.task0).toEqual(gen0Task);
    expect(cardinality.successor?.worktreeRoot).toBe(firstPreview.plan.worktree.root);
    expect(cardinality.current?.worktreeRoot).toBe(active.result!.worktree.root);
    await expect(
      new RuntimeOwnerDecisions(store.ownerDecisions, Date.now).resolve(
        {
          workspaceId: savedFirstRecord.preview.selection.workspaceId,
          roomId: savedFirstRecord.preview.selection.roomId,
          runId: 'rebind-' + savedFirstRecord.preview.epochId,
          decisionId: savedFirstRecord.decisionId,
        },
        savedFirstRecord.bindingDigest,
        archivedDecision!.version,
        'allow-once',
      ),
    ).resolves.toMatchObject({ status: 'allowed' });
    const state = stores.readRestorationBackupState(join(second, 'runtime.sqlite'));
    expect(state.origins).toHaveLength(2);
    expect(state.retired.map((entry) => entry.requestId)).toEqual(['rebind-1']);
    expect(state.activeRequestId).toBe('rebind-2');
  } finally {
    store.close();
  }
  // A later fresh public backup proves the new ready graph is internally consistent.
  const archive3 = join(dir, 'archive-3');
  await backupProfile(second, archive3);
  const third = adapters.verifyProfileLineageGraph(archive3, stores.readProfileRestoreSnapshot);
  const thirdDepth = (node: typeof third | null): number =>
    node ? 1 + thirdDepth(node.parent) : 0;
  expect(thirdDepth(third)).toBe(3);
  expect(
    Object.fromEntries(third.manifest.lineage!.tasks.map((task) => [task.taskId, task.source])),
  ).toEqual({
    [gen0Task.id]: 'parent',
    [successor]: 'parent',
    [secondResult.successorTaskId]: 'live',
  });
  expect(third.manifest.lineage!.intents.map((intent) => intent.requestId)).toEqual(['rebind-2']);
  fs.rmSync(selected2, { recursive: true });
  const runtime = createRuntime({ dbPath: join(second, 'runtime.sqlite') });
  try {
    await runtime.ready;
    const access = (taskId: string) => ({
      workspaceId: 'ws_ocean',
      roomId: gen0Task.ownerRoomId,
      botId: gen0Task.devBotId,
      taskId,
      policyVersion: 1 as const,
      capability: 'project_read' as const,
    });
    expect(runtime.coding.authorize(access(gen0Task.id)).ok).toBe(false);
    expect(runtime.coding.authorize(access(successor)).ok).toBe(false);
    expect(runtime.coding.authorize(access(secondResult.successorTaskId)).ok).toBe(true);
  } finally {
    runtime.close();
  }
}, 240000);
