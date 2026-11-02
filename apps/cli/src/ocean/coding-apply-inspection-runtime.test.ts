import { writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { GitCodingApplyProject } from '@runnets/tools-node';
import { createRuntime } from '../runtime.js';
import { codingWorkflowFixture, faultyMath } from './coding-workflow-fixture.js';
import { runCodingCommand } from './coding-command.js';
import { oceanArguments } from './arguments.js';
it.runIf(process.platform === 'linux')(
  'inspects exact held application through owner CLI while preserving receipt, files and global hold',
  async () => {
    const f = await codingWorkflowFixture('direct');
    try {
      writeFileSync(join(f.worktree, 'math.cjs'), faultyMath);
      const artifact = await f.capture('capture');
      const store = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
      try {
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
        await new GitCodingApplyProject().applyFile(f.project, artifact.files[0]!, {
          ownerId: store.coding.atomic((tx) => tx.task('task')!).lease.ownerId,
          taskId: 'task',
          applicationId: 'apply',
          changesetHash: artifact.hash,
        });
        f.runtime.codingApply!.recover();
        const before = store.codingApplications.atomic((tx) => tx.application('apply'));
        const pending = await f.runtime.toolJournal!.pending();
        expect(
          await runCodingCommand(f.runtime, oceanArguments(['coding', 'pending']), 'pending'),
        ).toEqual({
          applications: [{ applicationId: 'apply', outcome: 'uncertain' }],
          otherEffects: [],
        });
        const inspect = () =>
          f.runtime.codingApplyInspection!.inspect({
            workspaceId: 'ws_ocean',
            applicationId: 'apply',
          });
        expect(await inspect()).toMatchObject({
          ok: true,
          value: {
            holdReleased: false,
            receipt: { status: 'uncertain' },
            files: [{ path: 'math.cjs', comparison: 'after' }],
          },
        });
        expect(
          await runCodingCommand(
            f.runtime,
            oceanArguments(['coding', 'inspect-apply', 'apply']),
            'inspect',
          ),
        ).toMatchObject({ holdReleased: false, files: [{ comparison: 'after' }] });
        chmodSync(join(f.project, 'math.cjs'), 0o755);
        expect(await inspect()).toMatchObject({
          ok: true,
          value: { files: [{ comparison: 'conflict' }] },
        });
        writeFileSync(join(f.project, 'math.cjs'), 'user');
        expect(await inspect()).toMatchObject({
          ok: true,
          value: { files: [{ comparison: 'conflict' }] },
        });
        rmSync(join(f.project, 'math.cjs'));
        symlinkSync('/etc/passwd', join(f.project, 'math.cjs'));
        expect(await inspect()).toMatchObject({
          ok: true,
          value: { files: [{ comparison: 'unavailable', kind: 'unavailable' }] },
        });
        expect(await f.runtime.toolJournal!.pending()).toEqual(pending);
        expect(store.codingApplications.atomic((tx) => tx.application('apply'))).toEqual(before);
        expect(f.previews).toEqual([]);
      } finally {
        store.close();
      }
      f.runtime.close();
      writeFileSync(join(f.directory, 'restore-guard.json'), '{}');
      const restored = createRuntime({
        dbPath: join(f.directory, 'runtime.sqlite'),
        restoredAccess: true,
      });
      try {
        await restored.ready;
        expect(
          (
            await restored.codingApplyInspection!.inspect({
              workspaceId: 'ws_ocean',
              applicationId: 'apply',
            })
          ).ok,
        ).toBe(false);
      } finally {
        restored.close();
      }
    } finally {
      f.close();
    }
  },
);
