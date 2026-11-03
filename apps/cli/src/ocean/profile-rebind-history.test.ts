import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  ProfileRebindService,
  RuntimeOwnerDecisions,
  type ProviderPort,
} from '@runnets/application';
import * as stores from '@runnets/store-sqlite';
import * as adapters from '@runnets/tools-node';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { backupProfile, restoreProfile } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { startLocalRuntime, type LocalRuntimeHost } from '../local-runtime/host.js';

function historyRows(path: string, changesetHash: string, runId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const get = (sql: string, ...args: string[]) => db.prepare(sql).get(...args) ?? null;
    return {
      task: get('SELECT payload FROM ocean_coding_tasks WHERE id=?', 'task'),
      changeset: get('SELECT payload FROM ocean_changesets WHERE hash=?', changesetHash),
      review: get('SELECT payload FROM ocean_coding_review_requests WHERE id=?', 'review-history'),
      verdict: get(
        'SELECT payload FROM ocean_coding_review_verdicts WHERE request_id=?',
        'review-history',
      ),
      run: db
        .prepare('SELECT type,payload FROM events WHERE aggregate_id=? ORDER BY sequence')
        .all(runId),
      turns: db.prepare('SELECT payload FROM ocean_chat_turns WHERE task_run_id=?').all(runId),
    };
  } finally {
    db.close();
  }
}
/** Read a verified frozen database only through a held descriptor, as the product does. */
function frozen<T>(path: string, work: (fdPath: string) => T): T {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return work('/proc/self/fd/' + fd);
  } finally {
    fs.closeSync(fd);
  }
}
const textProvider: ProviderPort = {
  id: 'fixture',
  models: ['fixture'],
  capabilities: { streaming: true, usage: true, reasoning: false },
  async *stream() {
    yield { type: 'text_delta', text: 'fixture history answer' };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
  },
};

it('keeps exact old task/changeset/review/run history and diffs readable from frozen origin evidence', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'rebind-history-'));
  fs.mkdirSync(join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('HOME', join(root, 'home'));
  const f = await codingWorkflowFixture('direct');
  let store: ReturnType<typeof stores.openSqliteStore> | undefined;
  let host: LocalRuntimeHost | undefined;
  try {
    const selected = join(root, 'new-project');
    execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'old frozen history\n');
    const artifact = await f.capture('history-changeset');
    const sent = await f.send('history-run', textProvider);
    if (!sent.ok) throw Error(sent.error.code);
    const runId = String(sent.value.taskRunId);
    const requested = await f.runtime.codingReview!.request(
      {
        id: 'review-history',
        workspaceId: 'ws_ocean',
        taskId: 'task',
        changesetHash: artifact.hash,
      },
      { confirm: async () => true },
    );
    if (!requested.ok) throw Error(requested.error.code);
    const reviewed = await f.runtime.codingReview!.dispatch('review-history', {
      review: async () => ({
        verdict: 'changes_requested',
        findings: [
          {
            path: 'answer.txt',
            side: 'after',
            line: 1,
            severity: 'important',
            explanation: 'Exact frozen review finding',
          },
        ],
        summary: 'Exact frozen review summary',
      }),
    });
    if (!reviewed.ok) throw Error(reviewed.error.code);
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const inventory = stores.readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
    fs.writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        {
          id: 'project',
          root: f.project,
          testPresets: inventory.tasks[0]!.policy.testPresets,
          mounts: [],
        },
      ]),
      { mode: 0o600 },
    );
    const source = historyRows(join(f.directory, 'runtime.sqlite'), artifact.hash, runId);
    expect(JSON.parse(String((source.changeset as { payload: string }).payload)).diff).toContain(
      'answer.txt',
    );
    expect(source.review).not.toBeNull();
    expect(source.verdict).not.toBeNull();
    expect((source.run as unknown[]).length).toBeGreaterThan(0);
    // The verified format-2 archive is independent evidence before restore.
    const archive = join(root, 'archive');
    const manifest = await backupProfile(f.directory, archive, {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    expect(manifest.format).toBe(2);
    expect(historyRows(join(archive, 'runtime.sqlite'), artifact.hash, runId)).toEqual(source);
    const archived = frozen(join(archive, 'runtime.sqlite'), (fd) =>
      stores.readProfileRestoreSnapshot(fd),
    );
    expect(archived.coding.changesets.map((c) => c.hash)).toEqual([artifact.hash]);
    expect(archived.tasks.map((t) => t.id)).toEqual(['task']);
    fs.rmSync(f.directory, { recursive: true });
    const profile = join(root, 'profile');
    restoreProfile(archive, profile);
    fs.rmSync(archive, { recursive: true });
    store = stores.openSqliteStore({ path: join(profile, 'runtime.sqlite') });
    const origin = store.restoration.origin()!;
    const old = store.coding.atomic((tx) => tx.task('task'))!;
    const owner = new RuntimeOwnerDecisions(store.ownerDecisions, Date.now);
    const service = new ProfileRebindService({
      store: store.rebind,
      files: new adapters.RestoredProfileFiles(profile, stores.readProfileRestoreSnapshot),
      owner,
      leases: new adapters.SqliteProjectLeases(),
      now: Date.now,
      nextId: randomUUID,
      digest: (text: string) => createHash('sha256').update(text).digest('hex'),
    });
    const selection = {
      requestId: 'history-rebind',
      workspaceId: old.workspaceId,
      roomId: old.ownerRoomId,
      profileId: origin.profileId,
      snapshotId: origin.snapshotId,
      sourceOwnerId: old.lease.ownerId,
      taskId: old.id,
      projectRoot: selected,
      baseCommit: old.baseCommit,
      treeHash: await new adapters.GitCodingApplyProject().tree(selected, old.baseCommit),
      policy: old.policy,
    };
    const card = await service.preview(selection);
    await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
    await service.join();
    const record = service.result(selection);
    expect(record.state, record.reason ?? '').toBe('ready');
    await service.close();
    store.close();
    store = undefined;
    // The frozen origin is retained and is byte-exact old history; the mutable database
    // also never rewrote or deleted the old rows.
    expect(
      historyRows(join(profile, 'restore-origin/runtime.sqlite'), artifact.hash, runId),
    ).toEqual(source);
    expect(historyRows(join(profile, 'runtime.sqlite'), artifact.hash, runId)).toEqual(source);
    const frozenOrigin = frozen(join(profile, 'restore-origin/runtime.sqlite'), (fd) =>
      stores.readProfileRestoreSnapshot(fd),
    );
    expect(frozenOrigin.tasks.map((t) => t.id)).toEqual(['task']);
    expect(
      frozenOrigin.coding.changesets[0]?.files.find((file) => file.path === 'answer.txt')?.after
        ?.sha256,
    ).toBe(createHash('sha256').update('old frozen history\n').digest('hex'));
    // Live coding projections stay current-epoch/owner-scoped and refuse the old task id.
    host = await startLocalRuntime({ profile, provider: null });
    const client: LocalRuntimeClient = await connectLocalRuntime({ profile });
    try {
      await expect(
        client.codingRead('coding.show', {
          workspaceId: 'ws_ocean',
          id: 'task',
          roomId: old.ownerRoomId,
        }),
      ).rejects.toThrow('coding_denied');
      await expect(
        client.codingRead('coding.diff', {
          workspaceId: 'ws_ocean',
          id: 'task',
          roomId: old.ownerRoomId,
        }),
      ).rejects.toThrow('coding_denied');
      const successor = record.result!.task;
      const shown = await client.codingRead('coding.show', {
        workspaceId: 'ws_ocean',
        id: successor.id,
        roomId: successor.ownerRoomId,
      });
      expect(shown).toMatchObject({ id: successor.id });
    } finally {
      client.close();
    }
    expect((await host.stop()).outcome).toBe('complete');
    await host.closed;
    host = undefined;
  } finally {
    if (host) {
      const stopped = await host.stop();
      if (stopped.outcome === 'complete') await host.closed;
    }
    store?.close();
    f.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
