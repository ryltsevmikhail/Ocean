import { execFile, spawn } from 'node:child_process';
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import { codingWorkflowFixture, initialMath } from '../ocean/coding-workflow-fixture.js';
import { registerCodingProject } from '../ocean/coding-projects.js';

it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['vote', 'expired'])(
  'two independent clients vote on one native write (%s)',
  async (mode) => {
    const f = await codingWorkflowFixture('direct');
    const run = mkdtempSync(join(tmpdir(), 'ocean-vote-'));
    const env = {
      PATH: process.env['PATH'],
      XDG_RUNTIME_DIR: run,
      DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'],
    };
    const scope = { workspaceId: 'ws_ocean', roomId: f.room };
    const peer = decisionPeer(f.directory, run);
    try {
      const task = f.runtime.coding.inspect(scope.workspaceId, 'task');
      if (!task.ok) throw Error('fixture task');
      await registerCodingProject(
        f.directory,
        { id: 'fixture', root: f.project, mounts: [], testPresets: task.value.policy.testPresets },
        async () => true,
      );
      f.runtime.close();
      chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      const owner = spawn(
        process.execPath,
        ['apps/cli/test-fixtures/decision-crash-worker.test.ts', f.directory, f.room, mode],
        { env },
      );
      const exited = new Promise((resolve) => owner.once('close', resolve));
      let log = '';
      for (const stream of [owner.stdout, owner.stderr]) stream.on('data', (b) => (log += b));
      try {
        await vi.waitFor(() => expect(log).toContain('ready'), { timeout: 5000 });
        const receipt = await peer('submit', {
          ...scope,
          requestId: 'edit',
          taskId: 'task',
          text: 'fixture',
        });
        const card = await vi.waitFor(
          async () => {
            const [card] = await peer('listDecisions', scope);
            expect(card).toMatchObject({
              status: 'pending',
              kind: 'write',
              version: 1,
              runId: receipt.runId,
            });
            return card;
          },
          { timeout: 15000 },
        );
        const ref = { ...scope, runId: receipt.runId, decisionId: card.decisionId };
        const vote = {
          ...ref,
          choice: 'allow-once',
          expectedVersion: card.version,
          bindingDigest: card.bindingDigest,
        };
        for (const [patch, code] of [
          [{ roomId: 'foreign' }, 'unknown_decision'],
          [{ runId: 'foreign' }, 'unknown_decision'],
          [{ bindingDigest: '0'.repeat(64) }, 'binding_conflict'],
          [{ expectedVersion: 2 }, 'version_conflict'],
        ] as const)
          await expect(peer('resolveDecision', { ...vote, ...patch })).rejects.toThrow(code);
        const [a, b] = await Promise.all(
          ['one', 'two'].map(async (role) => {
            const { stdout } = await promisify(execFile)(
              process.execPath,
              [
                'apps/cli/test-fixtures/decision-voter.test.ts',
                f.directory,
                JSON.stringify(ref),
                role,
                mode,
              ],
              { env, timeout: 10000 },
            );
            return JSON.parse(stdout);
          }),
        );
        expect(b).toEqual(a);
        expect(a.card).toEqual(card);
        const binding = JSON.parse(a.preview).binding;
        expect(binding).toMatchObject({
          ...scope,
          runId: receipt.runId,
          taskId: 'task',
          operation: 'write',
        });
        expect(a.winner).toMatchObject({
          ...card,
          status: mode === 'vote' ? 'allowed' : 'expired',
          version: 2,
        });
        expect(a.stale).toEqual(a.winner);
        expect(a.persisted).toEqual(a.winner);
        const runRef = { ...scope, runId: receipt.runId };
        await vi.waitFor(
          async () =>
            expect(await peer('getRun', runRef)).toMatchObject({ turnStatus: 'completed' }),
          { timeout: 10000 },
        );
        expect(await peer('stop', {})).toMatchObject({ outcome: 'complete' });
        expect(await exited).toBe(0);
        const effects = join(f.directory, 'effects');
        expect(existsSync(effects) ? readFileSync(effects, 'utf8') : '').toBe(
          mode === 'vote' ? 'write\n' : '',
        );
        expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(
          mode === 'vote' ? 'crash fixture' : initialMath,
        );
        expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(initialMath);
        const db = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
        try {
          const grant = db.codingApprovals.atomic((tx) => tx.approval(card.decisionId)?.status);
          expect(grant).toBe(mode === 'vote' ? 'consumed' : 'denied');
          console.info(
            'Native voters',
            JSON.stringify(receipt),
            card.decisionId,
            card.bindingDigest,
            'winner',
            a.winner.status,
            'version',
            a.winner.version,
            'grant',
            grant,
            'writes',
            mode === 'vote' ? 1 : 0,
          );
        } finally {
          db.close();
        }
      } finally {
        owner.kill('SIGKILL');
        await exited;
      }
    } finally {
      f.close();
      rmSync(run, { recursive: true, force: true });
    }
  },
  40000,
);
