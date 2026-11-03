import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { openSqliteStore } from '@runnets/store-sqlite';
import { codingWorkflowFixture, initialMath } from '../ocean/coding-workflow-fixture.js';
import { registerCodingProject } from '../ocean/coding-projects.js';
import { startLocalRuntime } from './host.js';
it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['pending', 'winner', 'allowed', 'claim', 'effect'])(
  'kills a real coding application at %s and reopens twice without dispatch',
  async (phase) => {
    const f = await codingWorkflowFixture('direct');
    const runDir = mkdtempSync(join(tmpdir(), 'ocean-crash-run-'));
    vi.stubEnv('XDG_RUNTIME_DIR', runDir);
    try {
      const task = f.runtime.coding.inspect('ws_ocean', 'task');
      if (!task.ok) throw Error('fixture task');
      await registerCodingProject(
        f.directory,
        { id: 'fixture', root: f.project, mounts: [], testPresets: task.value.policy.testPresets },
        async () => true,
      );
      f.runtime.close();
      chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
      const child = spawn(
        process.execPath,
        ['apps/cli/test-fixtures/decision-crash-worker.test.ts', f.directory, f.room, phase],
        {
          env: {
            ...Object.fromEntries(
              [
                'HOME',
                'XDG_RUNTIME_DIR',
                'XDG_CONFIG_HOME',
                'XDG_DATA_HOME',
                'XDG_STATE_HOME',
                'XDG_CACHE_HOME',
                'TMPDIR',
              ].map((key) => [key, process.env[key]]),
            ),
            PATH: process.env['PATH'],
            HOME: process.env['HOME'],
            XDG_RUNTIME_DIR: runDir,
            DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'],
          },
        },
      );
      const exit = new Promise((r) => child.once('close', (_code, signal) => r(signal)));
      let err = '',
        out = '';
      child.stderr.on('data', (b: Buffer) => {
        err += b.toString();
      });
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
      });
      try {
        if (phase === 'effect') {
          await vi.waitFor(() => expect(out, err).toBe('ready\n'), { timeout: 5000 });
          const client = await connectLocalRuntime({ profile: f.directory });
          try {
            const scope = { workspaceId: 'ws_ocean', roomId: f.room };
            const { runId } = await client.submit({
              ...scope,
              requestId: 'crash',
              taskId: 'task',
              text: 'synthetic',
            });
            const card = await vi.waitFor(
              async () => {
                const pending = (await client.listDecisions(scope)).find(
                  (c) => c.status === 'pending',
                );
                if (!pending) throw Error('waiting for native write');
                return pending;
              },
              { timeout: 15000 },
            );
            await client.resolveDecision({
              ...scope,
              runId: runId!,
              decisionId: card.decisionId,
              expectedVersion: card.version,
              bindingDigest: card.bindingDigest,
              choice: 'allow-once',
            });
          } finally {
            client.close();
          }
        }
        await vi.waitFor(
          () => expect(out, err).toBe((phase === 'effect' ? 'ready\n' : '') + phase + '\n'),
          { timeout: 15000 },
        );
      } finally {
        child.kill('SIGKILL');
        await exit;
      }
      expect(await exit).toBe('SIGKILL');
      const scope = { workspaceId: 'ws_ocean', roomId: f.room };
      for (let i = 0; i < 2; i++) {
        const host = await startLocalRuntime({ profile: f.directory, provider: null });
        const c = await connectLocalRuntime({ profile: f.directory });
        try {
          const card = (await c.listDecisions(scope))[0]!;
          const ref = { ...scope, runId: card.runId, decisionId: card.decisionId };
          expect(card.status).toBe(phase === 'pending' ? 'interrupted' : 'allowed');
          expect(
            await c.resolveDecision({
              ...ref,
              expectedVersion: 1,
              bindingDigest: card.bindingDigest,
              choice: 'allow-once',
            }),
          ).toEqual(card);
          expect(await c.getRun({ ...scope, runId: card.runId })).toMatchObject({
            turnStatus: 'uncertain',
            pendingDecisionIds: [],
          });
          const old = await c.submit({
            ...scope,
            taskId: 'task',
            text: 'synthetic',
            requestId: 'crash',
          });
          expect(old.runId).toBe(card.runId);
          expect(await c.history(scope)).toHaveLength(1);
          expect(host.recovery.effects).toHaveLength(['claim', 'effect'].includes(phase) ? 1 : 0);
          if (host.recovery.effects.length)
            expect(host.recovery.effects[0]).toMatchObject({ outcome: 'uncertain' });
          const db = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
          try {
            expect(db.codingApprovals.atomic((tx) => tx.approval(card.decisionId)?.status)).toBe(
              ['pending', 'winner'].includes(phase)
                ? 'pending'
                : phase === 'allowed'
                  ? 'allowed'
                  : 'consumed',
            );
          } finally {
            db.close();
          }
          expect(readFileSync(join(f.directory, 'calls'), 'utf8')).toBe('provider\nprovider\n');
          expect(
            existsSync(join(f.directory, 'effects'))
              ? readFileSync(join(f.directory, 'effects'), 'utf8')
              : '',
          ).toBe(phase === 'effect' ? 'write\n' : '');
          expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(
            phase === 'effect' ? 'crash fixture' : initialMath,
          );
        } finally {
          c.close();
          await host.stop();
          await host.closed;
        }
      }
    } finally {
      f.close();
      rmSync(runDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
  30000,
);
