import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ModelCodingReviewer, type RuntimeRecovery, type ProviderPort } from '@runnets/application';
import { codingApplicationVerified, codingTestPassed, taskRunId } from '@runnets/domain';
import type { Changeset, CodingTask, CodingTestEvidence } from '@runnets/domain';
import { openSqliteStore } from '@runnets/store-sqlite';
import { codingWorkflowFixture, initialMath, repairedMath } from './coding-workflow-fixture.js';
import { createRuntime, type Runtime } from '../runtime.js';

const row = (path: string, sql: string, value: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).get(value);
  } finally {
    database.close();
  }
};
async function reopen<T>(
  path: string,
  work: (runtime: Runtime, recovery: RuntimeRecovery) => Promise<T>,
): Promise<T> {
  const runtime = createRuntime({ dbPath: path });
  try {
    const recovery = await runtime.ready;
    return await work(runtime, recovery);
  } finally {
    runtime.close();
  }
}
async function killedWorker(directory: string, room: string): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), 'ocean-persist-run-'));
  try {
    const child = spawn(
      process.execPath,
      ['apps/cli/test-fixtures/coding-test-persist-crash-worker.test.ts', directory, room],
      {
        cwd: process.cwd(),
        env: {
          ...(Object.fromEntries(
            [
              'HOME',
              'XDG_RUNTIME_DIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'XDG_STATE_HOME',
              'XDG_CACHE_HOME',
              'TMPDIR',
            ].map((key) => [key, process.env[key]]),
          ) as Record<string, string>),
          PATH: process.env['PATH']!,
          XDG_RUNTIME_DIR: runDir,
        },
      },
    );
    let err = '',
      out = '';
    child.stderr.on('data', (buffer: Buffer) => {
      err += buffer.toString();
    });
    child.stdout.on('data', (buffer: Buffer) => {
      out += buffer.toString();
    });
    const exit = new Promise<[number | null, string | null]>((resolve) =>
      child.once('close', (code, signal) => resolve([code, signal])),
    );
    try {
      await vi.waitFor(() => expect(out, err).toContain('ready\n'), { timeout: 15000 });
      await vi.waitFor(() => expect(out, err).toContain('evidence\n'), { timeout: 30000 });
    } finally {
      child.kill('SIGKILL');
    }
    expect(await exit).toEqual([null, 'SIGKILL']);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains a passed test result but not application authority when killed before settlement',
  async () => {
    const f = await codingWorkflowFixture('direct');
    const database = join(f.directory, 'runtime.sqlite');
    writeFileSync(join(f.worktree, 'math.cjs'), repairedMath);
    const changeset: Changeset = await f.capture('capture');
    f.runtime.close();
    let evidence: CodingTestEvidence | null = null;
    try {
      chmodSync(database, 0o600);
      await killedWorker(f.directory, f.room);
      for (let index = 0; index < 2; index++)
        await reopen(database, async (runtime, recovery) => {
          expect(recovery.effects).toMatchObject([{ tool: 'coding_test', outcome: 'uncertain' }]);
          const retained = runtime.codingEvidence!.list('task');
          expect(retained).toHaveLength(1);
          evidence = retained[0]!;
          expect(evidence.presetId).toBe('test');
          // The executed preset really passed, but only the journal decides authority.
          expect(codingTestPassed(evidence)).toBe(true);
          expect(await runtime.toolJournal!.pending()).toMatchObject([
            { tool: 'coding_test', outcome: 'uncertain', id: evidence.binding.invocationId },
          ]);
          expect(
            row(database, 'SELECT outcome FROM tool_invocations_v2 WHERE tool=?', 'coding_test'),
          ).toMatchObject({
            outcome: 'uncertain',
          });
          // A settled claim is missing, so no new external effect may be claimed.
          expect(
            await runtime.toolJournal!.claim(
              'fresh',
              'coding_test',
              { taskRunId: 'unrelated', attemptId: 'unrelated' },
              'fingerprint',
            ),
          ).toBe(false);
          expect(runtime.codingEvidence!.list('task')).toHaveLength(1);
        });
      expect(evidence).not.toBeNull();
      // The hold allows no application even with a current exact approval and the retained evidence.
      await reopen(database, async (runtime) => {
        const inspected = runtime.coding.inspect('ws_ocean', 'task');
        if (!inspected.ok) throw Error('fixture task');
        const task: CodingTask = inspected.value;
        const store = openSqliteStore({ path: database });
        let stored: Changeset | null = null;
        try {
          stored = store.coding.atomic((tx) => tx.changeset(changeset.hash));
        } finally {
          store.close();
        }
        if (!stored) throw Error('fixture changeset');
        expect(
          await runtime.codingReview!.request(
            {
              id: 'review',
              workspaceId: 'ws_ocean',
              taskId: 'task',
              changesetHash: changeset.hash,
            },
            { confirm: async () => true },
          ),
        ).toMatchObject({ ok: true });
        const reviewProvider: ProviderPort = {
          id: 'fixture',
          models: ['fixture'],
          capabilities: { streaming: true, usage: true, reasoning: false },
          async *stream() {
            yield {
              type: 'text_delta',
              text: JSON.stringify({ verdict: 'approve', summary: 'Fixture', findings: [] }),
            };
            yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
            yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
          },
        };
        const verdict = await runtime.codingReview!.dispatch(
          'review',
          new ModelCodingReviewer({
            tasks: runtime.service,
            provider: reviewProvider,
            model: 'fixture',
            nextRunId: () => taskRunId('tr_review'),
            signal: new AbortController().signal,
            emit: () => {},
          }),
        );
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) return;
        const retained = runtime.codingEvidence!.list('task');
        expect(codingApplicationVerified(task, stored, verdict.value, retained)).toBe(true);
        let ownerCalls = 0;
        const applied = await runtime.codingApply!.apply(
          {
            id: 'apply',
            workspaceId: 'ws_ocean',
            taskId: 'task',
            changesetHash: changeset.hash,
            reviewRequestId: 'review',
            expectedBase: f.base,
          },
          {
            confirm: async () => {
              ownerCalls++;
              return true;
            },
          },
        );
        expect(applied).toEqual({ ok: false, error: { code: 'coding_denied' } });
        expect(ownerCalls).toBe(0);
        expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(initialMath);
        expect(runtime.codingEvidence!.list('task')).toHaveLength(1);
        expect(await runtime.toolJournal!.pending()).toHaveLength(1);
      });
    } finally {
      f.close();
    }
  },
  90000,
);
