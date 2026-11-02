import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStore, inspectDatabase } from '@runnets/store-sqlite';
import { GitCodingApplyProject, SqliteProjectLeases } from '@runnets/tools-node';
import { createRuntime } from '../runtime.js';
import { codingWorkflowFixture, faultyMath } from './coding-workflow-fixture.js';
it
  .runIf(process.platform === 'linux')
  .each(['after', 'before', 'deny', 'stale', 'conflict', 'restored', 'lease_lost'])(
  'records exact owner reconciliation %s without replay or rewriting uncertain history',
  async (mode) => {
    const f = await codingWorkflowFixture('direct');
    let runtime = f.runtime;
    const path = join(f.directory, 'runtime.sqlite');
    const store = openSqliteStore({ path });
    try {
      writeFileSync(join(f.worktree, 'math.cjs'), faultyMath);
      const artifact = await f.capture('capture');
      store.codingApplications.atomic((tx) =>
        expect(
          tx.claimApplication({
            id: 'apply',
            taskId: 'task',
            changesetHash: artifact.hash,
            reviewRequestId: 'fixture',
            expectedBase: f.base,
            status: 'applying',
            files: [{ path: 'math.cjs', status: 'pending' }],
          }),
        ).toBe(true),
      );
      store.codingApplications.atomic((tx) =>
        tx.putApplication({
          ...tx.application('apply')!,
          files: [{ path: 'math.cjs', status: 'started' }],
        }),
      );
      if (mode !== 'before')
        await new GitCodingApplyProject().applyFile(f.project, artifact.files[0]!);
      runtime.codingApply!.recover();
      const receipt = store.codingApplications.atomic((tx) => tx.application('apply'));
      if (mode === 'conflict') writeFileSync(join(f.project, 'unrelated-user'), 'keep');
      if (mode === 'lease_lost') {
        const task = runtime.coding.inspect('ws_ocean', 'task');
        if (!task.ok) throw Error(task.error.code);
        expect(new SqliteProjectLeases().release(task.value.lease)).toBe(true);
      }
      if (mode === 'restored') {
        runtime.close();
        writeFileSync(join(f.directory, 'restore-guard.json'), '{}');
        runtime = createRuntime({ dbPath: path, restoredAccess: true });
        await runtime.ready;
      }
      let approvals = 0;
      const input = {
        workspaceId: 'ws_ocean',
        applicationId: 'apply',
        accepted: mode === 'before' ? ('before' as const) : ('after' as const),
        reason: 'Inspected complete eligible tree',
      };
      const owner = {
        confirm: async () => {
          approvals++;
          if (mode === 'stale') writeFileSync(join(f.project, 'math.cjs'), 'user');
          return mode !== 'deny';
        },
      };
      expect(runtime.codingApplyResolution).toBeDefined();
      const result = await runtime.codingApplyResolution!.reconcile(input, owner);
      expect(result.ok).toBe(['after', 'before'].includes(mode));
      expect(store.codingApplications.atomic((tx) => tx.application('apply'))).toEqual(receipt);
      if (result.ok) {
        expect(await runtime.toolJournal!.pending()).toEqual([]);
        expect(store.codingResolutions.atomic((tx) => tx.resolution('apply'))).toEqual(
          result.value,
        );
        expect((await runtime.codingApplyResolution!.reconcile(input, owner)).ok).toBe(false);
        expect(approvals).toBe(1);
        expect(
          await store.tools.claim('other', 'write', { taskRunId: 'new', attemptId: 'new' }, 'new'),
        ).toBe(true);
        await store.tools.settle('other', 'not_started', { taskRunId: 'new', attemptId: 'new' });
        runtime.close();
        runtime = createRuntime({ dbPath: path });
        await runtime.ready;
        expect(await runtime.toolJournal!.pending()).toEqual([]);
        runtime.close();
        expect(inspectDatabase(path)).toMatchObject({
          status: 'ok',
          summary: { pendingEffects: 0 },
        });
      } else {
        expect(await runtime.toolJournal!.pending()).toHaveLength(1);
        expect(approvals).toBe(['conflict', 'restored', 'lease_lost'].includes(mode) ? 0 : 1);
      }
      expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
      expect(f.git('diff', '--cached')).toBe('');
    } finally {
      store.close();
      runtime.close();
      f.close();
    }
  },
);
