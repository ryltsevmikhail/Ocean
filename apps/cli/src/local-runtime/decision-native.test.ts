import { registeredCodingTools } from '../ocean/coding-project-host.js';
import { decisionPeer } from '../../test-fixtures/decision-peer.test.js';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ProviderPort } from '@runnets/application';
import { connectLocalRuntime, SqliteProjectLeases } from '@runnets/tools-node';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  codingWorkflowFixture,
  initialMath,
  repairedMath,
} from '../ocean/coding-workflow-fixture.js';
import { registerCodingProject } from '../ocean/coding-projects.js';
import { startLocalRuntime } from './host.js';

it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each([
    'race',
    'source',
    'registry',
    'lease',
    'allow',
    'no-inspection',
    'added-mount',
    'missing-mount',
    'lease-mount',
  ])(
  'runs registered sandbox coding tools through the shared owner with %s',
  async (mode) => {
    const f = await codingWorkflowFixture('direct'),
      scope = { workspaceId: 'ws_ocean', roomId: f.room };
    let round = 0;
    const provider: ProviderPort = {
      id: 'fixture',
      models: ['fixture'],
      capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
      async *stream(request) {
        expect(request.tools?.map((t) => t.name)).toEqual(
          expect.arrayContaining(['write_file', 'run_test']),
        );
        expect(request.tools?.some((t) => t.name.includes('decision'))).toBe(false);
        const calls = [
          { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' },
          {
            id: 'write',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'math.cjs', content: repairedMath }),
          },
          ...(mode === 'allow'
            ? [{ id: 'test', name: 'run_test', arguments: '{"presetId":"test"}' }]
            : []),
        ];
        const call = calls[round++];
        if (call) yield { type: 'tool_call', call };
        else yield { type: 'text_delta', text: 'fixture answer' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield {
          type: 'completed',
          stopReason: call ? 'tool_calls' : 'stop',
          rawStopReason: call ? 'tool_calls' : 'stop',
        };
      },
    };
    const task = f.runtime.coding.inspect('ws_ocean', 'task');
    if (!task.ok) throw Error('fixture task');
    const dependencyProjectRoot = join(f.directory, 'deps'),
      source = join(dependencyProjectRoot, 'node_modules');
    mkdirSync(source, { recursive: true });
    const registered = {
      id: 'fixture',
      root: f.project,
      testPresets: task.value.policy.testPresets,
    };
    const mounts = [{ source, target: '/workspace/node_modules' }];
    await registerCodingProject(
      f.directory,
      {
        ...registered,
        dependencyProjectRoot,
        mounts: mode === 'missing-mount' || mode === 'lease-mount' ? mounts : [],
      },
      async () => true,
    );
    f.runtime.close();
    chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    mkdirSync(join(f.directory, 'run'), { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', join(f.directory, 'run'));
    const peer = decisionPeer(f.directory, join(f.directory, 'run'));
    const host = await startLocalRuntime({
      profile: f.directory,
      provider,
      ...(mode === 'no-inspection'
        ? { codingTools: { sandbox: registeredCodingTools(f.directory).sandbox } }
        : {}),
    });
    const connect = () => connectLocalRuntime({ profile: f.directory });
    const a = await connect(),
      b = await connect();
    try {
      const admitted = await a.submit({
        ...scope,
        requestId: 'edit',
        taskId: 'task',
        text: 'edit and test',
      });
      a.close();
      const run = { ...scope, runId: admitted.runId! };
      for (const kind of mode === 'allow' ? ['write', 'test'] : ['write']) {
        const card = await vi.waitFor(
          async () => {
            const c = (await b.listDecisions(scope)).find((c) => c.kind === kind);
            if (!c) throw Error('expected ' + kind + ' decision');
            return c;
          },
          { timeout: 15000 },
        );
        const ref = { ...run, decisionId: card.decisionId };
        const preview = JSON.parse(await b.decisionPreview(ref));
        expect(preview.binding).toMatchObject({
          ...run,
          taskId: 'task',
          operation: kind,
          projectRoot: f.project,
          worktreeRoot: f.worktree,
        });
        expect(preview.preview).toContain(kind === 'write' ? 'math.cjs' : '/toolchain/node');
        expect(await b.getRun(run)).toMatchObject({ pendingDecisionIds: [card.decisionId] });
        if (mode === 'source') writeFileSync(join(f.worktree, 'math.cjs'), 'external edit');
        if (mode === 'added-mount')
          writeFileSync(
            join(f.directory, 'coding-projects.json'),
            JSON.stringify([{ ...registered, dependencyProjectRoot, mounts }]),
          );
        if (mode === 'missing-mount' || mode === 'lease-mount')
          rmdirSync(join(f.worktree, 'node_modules'));
        if (mode === 'lease' || mode === 'lease-mount') {
          const store = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
          try {
            const lease = store.coding.atomic((tx) => tx.worktree('task')!.lease);
            expect(new SqliteProjectLeases().release(lease)).toBe(true);
          } finally {
            store.close();
          }
        }
        if (mode === 'registry') writeFileSync(join(f.directory, 'coding-projects.json'), '[]');
        const tree = () =>
          readdirSync(f.worktree, { recursive: true, encoding: 'utf8' })
            .sort()
            .map((entry) => {
              const path = join(f.worktree, entry);
              return [entry, lstatSync(path).isDirectory() ? null : readFileSync(path)];
            });
        const before = mode.endsWith('-mount') ? tree() : null;
        const cas = { ...ref, expectedVersion: card.version, bindingDigest: card.bindingDigest };
        await expect(
          b.resolveDecision({ ...cas, expectedVersion: 3, choice: 'allow-once' }),
        ).rejects.toThrow('version_conflict');
        if (mode === 'race') {
          const copies = await Promise.all([
            peer('decisionPreview', ref),
            peer('decisionPreview', ref),
          ]);
          expect(copies[0]).toEqual(copies[1]);
          expect(JSON.parse(copies[0])).toEqual(preview);
        }
        const results = await Promise.all(
          mode === 'race'
            ? [
                peer('resolveDecision', { ...cas, choice: 'allow-once' }),
                peer('resolveDecision', { ...cas, choice: 'deny' }),
              ]
            : [b.resolveDecision({ ...cas, choice: 'allow-once' })],
        );
        if (before) expect(tree()).toEqual(before);
        if (mode === 'race') expect(results[0]).toEqual(results[1]);
        else expect(results[0]?.status).toBe(mode === 'allow' ? 'allowed' : 'invalidated');
      }
      await vi.waitFor(
        async () => expect(await b.getRun(run)).toMatchObject({ turnStatus: 'completed' }),
        { timeout: 10000 },
      );
      const cards = await b.listDecisions(scope);
      expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(
        mode === 'source'
          ? 'external edit'
          : cards.some((c) => c.kind === 'write' && c.status === 'allowed')
            ? repairedMath
            : initialMath,
      );
      expect(readFileSync(join(f.project, 'math.cjs'), 'utf8')).toBe(initialMath);
      const db = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
      try {
        for (const card of cards) {
          expect(db.codingApprovals.atomic((tx) => tx.approval(card.decisionId)?.status)).toBe(
            card.status === 'allowed'
              ? 'consumed'
              : mode === 'lease' || mode === 'lease-mount'
                ? 'pending'
                : 'denied',
          );
        }
        expect(db.codingEvidence.list('task')).toHaveLength(mode === 'allow' ? 1 : 0);
        expect(db.tools.inspectPending?.()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      a.close();
      b.close();
      await host.stop();
      await host.closed;
      vi.unstubAllEnvs();
      f.close();
    }
  },
  35000,
);
