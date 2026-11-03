import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { codingWorkflowFixture, faultyMath, initialMath } from './coding-workflow-fixture.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { profileCli } from '../../test-fixtures/profile-cli.test.js';
it.each(['diff', 'held'])(
  'uses scoped read-only coding routes on a real %s task',
  async (mode) => {
    const f = await codingWorkflowFixture('direct');
    const applicationId = 'long-held-' + 'x'.repeat(150);
    try {
      writeFileSync(join(f.worktree, 'math.cjs'), faultyMath);
      if (mode === 'held') {
        const artifact = await f.capture('seed');
        const store = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
        try {
          expect(
            store.codingApplications.atomic((tx) =>
              tx.claimApplication({
                id: applicationId,
                taskId: 'task',
                changesetHash: artifact.hash,
                reviewRequestId: 'review',
                expectedBase: f.base,
                status: 'applying',
                files: [{ path: 'math.cjs', status: 'pending' }],
              }),
            ),
          ).toBe(true);
        } finally {
          store.close();
        }
      }
      f.runtime.close();
      chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      const run = join(f.directory, 'r');
      mkdirSync(run, { mode: 0o700 });
      vi.stubEnv('XDG_RUNTIME_DIR', run);
      const host = await startLocalRuntime({ profile: f.directory, provider: null });
      const cli = profileCli(f.directory, run);
      try {
        expect(await cli('coding', 'show', 'task')).toMatchObject({
          code: 0,
          reply: { data: { id: 'task', ownerRoomId: f.room } },
        });
        expect((await cli('coding', 'show', 'task', '--room', 'other')).reply.error.code).toBe(
          'coding_denied',
        );
        if (mode === 'diff') {
          const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
          try {
            const counts = () =>
              db
                .prepare(
                  'SELECT (SELECT count(*) FROM ocean_capture_receipts) AS receipts,(SELECT count(*) FROM ocean_changesets) AS artifacts',
                )
                .get();
            const before = counts();
            const view = (await cli('coding', 'diff', 'task')).reply.data;
            expect(view.diff).toContain('math.cjs');
            expect(view).toMatchObject({
              kind: 'preview',
              tests: [{ presetId: 'test', evidence: null }],
            });
            expect(counts()).toEqual(before);
          } finally {
            db.close();
          }
          expect((await cli('coding', 'diff', 'task', '--room', 'other')).reply.error.code).toBe(
            'coding_denied',
          );
          expect(
            (await cli('send', f.room, '--task', 'task', '--text', 'hello')).reply.error.code,
          ).toBe('provider_unavailable');
        } else {
          expect((await cli('coding', 'pending')).reply.data.applications).toMatchObject([
            { applicationId, outcome: 'uncertain' },
          ]);
          expect((await cli('coding', 'pending', '--room', 'other')).reply.data).toMatchObject({
            applications: [],
            omittedPendingEffects: 1,
          });
          expect((await cli('coding', 'inspect-apply', applicationId)).reply.data).toMatchObject({
            holdReleased: false,
            receipt: { id: applicationId, status: 'uncertain' },
          });
          expect(
            (await cli('coding', 'inspect-apply', applicationId, '--room', 'other')).reply.error
              .code,
          ).toBe('coding_denied');
        }
        expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(initialMath);
      } finally {
        await host.stop();
      }
    } finally {
      vi.unstubAllEnvs();
      f.close();
    }
  },
  12000,
);
