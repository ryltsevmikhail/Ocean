import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SqliteProjectLeases } from '@runnets/tools-node';
import type { ProjectLease } from '@runnets/domain';
import type { ConversationCommand } from '@runnets/application';
import { createRuntime } from '../runtime.js';
it.each(['apply', 'dirty', 'deny', 'restored', 'stale', 'refactor', 'expand', 'lease-lost'])(
  'routes durable owner application: %s',
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'ocean-apply-runtime-'));
    const project = join(directory, 'project');
    mkdirSync(project);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    if (mode === 'refactor') {
      mkdirSync(join(project, 'a/b'), { recursive: true });
      writeFileSync(join(project, 'a/b/file'), 'before');
    } else writeFileSync(join(project, mode === 'expand' ? 'a' : 'file'), 'before');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'base',
    );
    const base = git('rev-parse', 'HEAD');
    const options = {
      dbPath: join(directory, 'profile/runtime.sqlite'),
      codingWorktreeDirectory: join(directory, 'worktrees'),
    };
    mkdirSync(join(directory, 'profile'));
    let runtime = createRuntime(options);
    const leases = new SqliteProjectLeases(),
      held: ProjectLease[] = [];
    try {
      await runtime.ready;
      let sequence = 0;
      const command = (value: Record<string, unknown>) => {
        const result = runtime.conversations.execute({
          workspaceId: 'ws_ocean',
          requestId: String(++sequence),
          ...value,
        } as ConversationCommand);
        if (!result.ok) throw Error(result.error.code);
        return result.value.data.id;
      };
      command({ type: 'BindWorkspace', root: project });
      const bot = (handle: string) =>
        command({
          type: 'CreateBot',
          handle,
          name: handle,
          role: 'Fixture',
          provider: 'fixture',
          model: 'fixture',
        });
      const dev = bot('dev'),
        reviewer = bot('review');
      const room = command({ type: 'OpenDirectRoom', botId: dev }),
        reviewRoom = command({ type: 'OpenDirectRoom', botId: reviewer });
      const started = await runtime.coding.start(
        {
          workspaceId: 'ws_ocean',
          taskId: 'task',
          requestId: 'start',
          projectRoot: project,
          ownerRoomId: room,
          devBotId: dev,
          reviewRoomId: reviewRoom,
          reviewBotId: reviewer,
          devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
          testPresets: [{ id: 'test', program: process.execPath, args: ['--version'], cwd: '.' }],
        },
        { confirm: async () => true },
      );
      expect(started.ok).toBe(true);
      if (started.ok) held.push(started.value.lease);
      const access = {
        workspaceId: 'ws_ocean',
        taskId: 'task',
        roomId: room,
        botId: dev,
        policyVersion: 1,
        capability: 'project_read' as const,
      };
      const prepared = await runtime.codingChanges.prepare(access, { confirm: async () => true });
      if (!prepared.ok) throw Error(prepared.error.code);
      held.push(prepared.value.lease);
      const worktree = prepared.value.root;
      if (mode === 'refactor') {
        rmSync(join(worktree, 'a'), { recursive: true });
        writeFileSync(join(worktree, 'a'), 'after');
      } else if (mode === 'expand') {
        rmSync(join(worktree, 'a'));
        mkdirSync(join(worktree, 'a/b'), { recursive: true });
        writeFileSync(join(worktree, 'a/b/file'), 'after');
      } else writeFileSync(join(worktree, 'file'), 'after');
      const captured = await runtime.codingChanges.capture(access, 'capture');
      if (!captured.ok) throw Error(captured.error.code);
      const artifact = captured.value;
      runtime.codingEvidence!.put({
        id: 'test',
        hash: 'evidence',
        presetId: 'test',
        binding: {
          workspaceId: 'ws_ocean',
          taskId: 'task',
          projectRoot: project,
          worktreeRoot: worktree,
          roomId: room,
          botId: dev,
          runId: 'run',
          attemptId: 'attempt',
          invocationId: 'test',
          operation: 'test',
          operationHash: 'op',
          sourceTreeHash: artifact.afterTreeHash,
          policyVersion: 1,
          limitsHash: 'limits',
          toolchainHash: 'tools',
        },
        invocationHash: 'invocation',
        beforeTreeHash: artifact.afterTreeHash,
        afterTreeHash: artifact.afterTreeHash,
        dependencyHash: 'deps',
        dependenciesUnchanged: true,
        exitCode: 0,
        reason: 'exit',
        cleanupConfirmed: true,
        truncated: false,
        output: 'fixture evidence',
      });
      const review = await runtime.codingReview!.request(
        { id: 'review', workspaceId: 'ws_ocean', taskId: 'task', changesetHash: artifact.hash },
        { confirm: async () => true },
      );
      expect(review.ok).toBe(true);
      expect(
        (
          await runtime.codingReview!.dispatch('review', {
            review: async () => ({ verdict: 'approve', findings: [], summary: 'fixture' }),
          })
        ).ok,
      ).toBe(true);
      if (mode === 'lease-lost') expect(leases.release(held[0]!)).toBe(true);
      if (mode === 'dirty') writeFileSync(join(project, 'user'), 'keep');
      if (mode === 'stale') writeFileSync(join(worktree, 'file'), 'changed after review');
      if (mode === 'restored') {
        runtime.close();
        writeFileSync(join(directory, 'profile/restore-guard.json'), '{}');
        runtime = createRuntime({ ...options, restoredAccess: true });
        await runtime.ready;
      }
      const previews: unknown[] = [];
      expect(runtime.codingApply).toBeDefined();
      const result = await runtime.codingApply!.apply(
        {
          id: 'apply',
          workspaceId: 'ws_ocean',
          taskId: 'task',
          changesetHash: artifact.hash,
          reviewRequestId: 'review',
          expectedBase: base,
        },
        {
          confirm: async (preview) => {
            previews.push(preview);
            return mode !== 'deny';
          },
        },
      );
      expect(result.ok).toBe(['apply', 'refactor', 'expand'].includes(mode));
      expect(
        readFileSync(
          join(project, mode === 'refactor' ? 'a' : mode === 'expand' ? 'a/b/file' : 'file'),
          'utf8',
        ),
      ).toBe(['apply', 'refactor', 'expand'].includes(mode) ? 'after' : 'before');
      expect(previews.length).toBe(
        ['dirty', 'restored', 'stale', 'lease-lost'].includes(mode) ? 0 : 1,
      );
      expect(await runtime.toolJournal!.pending()).toEqual([]);
      expect(git('rev-parse', 'HEAD')).toBe(base);
      expect(git('diff', '--cached')).toBe('');
    } finally {
      runtime.close();
      for (const lease of held) leases.release(lease);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
