import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
/* eslint-disable no-restricted-imports -- Test-only fixture composing the same CLI package's runtime and project hosts. */
import { createRuntime } from '../src/runtime.js';
import { registerCodingProject } from '../src/ocean/coding-projects.js';
import type { CodingAccess, CodingTask, CodingTestEvidence, Changeset } from '@runnets/domain';
import type { ConversationCommand } from '@runnets/application';
const sandbox = (task: { worktreeRoot: string | null }) =>
  Promise.resolve({ root: task.worktreeRoot! });
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export function worktreeBytesHash(root: string): string {
  const digest = createHash('sha256');
  const walk = (path: string, relative: string) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name),
        key = relative === '' ? name : relative + '/' + name;
      if (statSync(child).isDirectory()) walk(child, key);
      else {
        digest.update('file\0' + key + '\0');
        digest.update(readFileSync(child));
      }
    }
  };
  walk(root, '');
  return digest.digest('hex');
}
export function codingRows(dbPath: string, taskId: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const all = (sql: string, ...params: string[]) =>
      db
        .prepare(sql)
        .all(...params)
        .map((row) => String(row['payload']));
    return {
      task: all('SELECT payload FROM ocean_coding_tasks WHERE id=?', taskId),
      changesets: all(
        'SELECT payload FROM ocean_changesets WHERE task_id=? ORDER BY rowid',
        taskId,
      ),
      reviews: all(
        "SELECT payload FROM ocean_coding_review_requests WHERE json_extract(payload,'$.binding.taskId')=? ORDER BY rowid",
        taskId,
      ),
      verdicts: all(
        "SELECT payload FROM ocean_coding_review_verdicts WHERE json_extract(payload,'$.binding.taskId')=? ORDER BY rowid",
        taskId,
      ),
      evidence: all(
        'SELECT payload FROM ocean_coding_test_evidence WHERE task_id=? ORDER BY rowid',
        taskId,
      ),
      finalization: all(
        'SELECT payload FROM ocean_coding_finalizations WHERE task_id=? ORDER BY rowid',
        taskId,
      ),
    };
  } finally {
    db.close();
  }
}
export function leaseRegistryRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      leases: db.prepare('SELECT token,root FROM project_leases_v1 ORDER BY token').all(),
      receipts: db
        .prepare('SELECT operation_id,token_hash,binding_digest FROM project_lease_receipts_v1')
        .all(),
    };
  } finally {
    db.close();
  }
}
export interface FinalizationFixture {
  readonly root: string;
  readonly home: string;
  readonly profile: string;
  readonly project: string;
  readonly db: string;
  readonly worktreeBase: string;
  readonly worktree: string;
  readonly room: string;
  readonly task: CodingTask;
  readonly changeset: Changeset;
  readonly evidence: CodingTestEvidence;
  readonly registryPath: string;
  readonly sandbox: typeof sandbox;
  close(): void;
}
/** Genuine protected prepared task with captured diff, test evidence and a completed review. */
export async function preparedFinalizationTask(sharedHome?: string): Promise<FinalizationFixture> {
  const root = mkdtempSync(join(tmpdir(), 'ocean-finalize-'));
  const home = sharedHome ?? join(root, 'home');
  if (!sharedHome) mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'math.cjs'), 'module.exports=(a,b)=>a+b;\n');
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', project, ...args], {
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const profile = join(root, 'profile');
  mkdirSync(profile, { mode: 0o700 });
  const db = join(profile, 'runtime.sqlite');
  const worktreeBase = join(root, 'worktrees');
  const runtime = createRuntime({
    dbPath: db,
    codingWorktreeDirectory: worktreeBase,
    codingTools: {
      sandbox,
      inspectSandbox: sandbox,
      owner: () => ({ decide: () => Promise.resolve('cancel' as const) }),
    },
  });
  try {
    await runtime.ready;
    let sequence = 0;
    const command = (value: Partial<ConversationCommand> & { type: string }) => {
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
    const room = command({ type: 'OpenDirectRoom', botId: dev });
    const reviewRoom = command({ type: 'OpenDirectRoom', botId: reviewer });
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
        devCapabilities: ['project_read', 'propose_write'],
        testPresets: [],
      },
      { confirm: () => Promise.resolve(true) },
    );
    if (!started.ok) throw Error(started.error.code);
    const access: CodingAccess = {
      workspaceId: 'ws_ocean',
      taskId: 'task',
      roomId: room,
      botId: dev,
      policyVersion: 1,
      capability: 'project_read',
    };
    const prepared = await runtime.codingChanges.prepare(access, {
      confirm: () => Promise.resolve(true),
    });
    if (!prepared.ok) throw Error(prepared.error.code);
    const captured = await runtime.codingChanges.capture(access, 'capture');
    if (!captured.ok) throw Error(captured.error.code);
    const changeset = captured.value;
    const binding = {
      workspaceId: 'ws_ocean',
      taskId: 'task',
      projectRoot: project,
      worktreeRoot: prepared.value.root,
      roomId: room,
      botId: dev,
      runId: 'run',
      attemptId: 'attempt',
      invocationId: 'invocation',
      operation: 'test' as const,
      operationHash: '1'.repeat(64),
      sourceTreeHash: changeset.afterTreeHash,
      policyVersion: 1,
      limitsHash: '2'.repeat(64),
      toolchainHash: '3'.repeat(64),
    };
    const evidence: CodingTestEvidence = {
      id: 'evidence',
      hash: '4'.repeat(64),
      binding,
      invocationHash: '5'.repeat(64),
      beforeTreeHash: changeset.afterTreeHash,
      afterTreeHash: changeset.afterTreeHash,
      dependencyHash: '6'.repeat(64),
      dependenciesUnchanged: true,
      exitCode: 0,
      reason: 'exit',
      cleanupConfirmed: true,
      truncated: false,
      output: 'ok',
    };
    runtime.codingEvidence!.put(evidence);
    const request = await runtime.codingReview!.request(
      { id: 'review-1', workspaceId: 'ws_ocean', taskId: 'task', changesetHash: changeset.hash },
      { confirm: () => Promise.resolve(true) },
    );
    if (!request.ok) throw Error(request.error.code);
    const verdict = await runtime.codingReview!.dispatch('review-1', {
      review: () =>
        Promise.resolve({ verdict: 'approve' as const, findings: [], summary: 'exact' }),
    });
    if (!verdict.ok) throw Error(verdict.error.code);
    const task = runtime.coding.inspect('ws_ocean', 'task');
    if (!task.ok) throw Error(task.error.code);
    runtime.close();
    await registerCodingProject(
      profile,
      { id: 'fixture', root: project, testPresets: [], mounts: [] },
      () => Promise.resolve(true),
    );
    chmodSync(db, 0o600);
    return {
      root,
      home,
      profile,
      project,
      db,
      worktreeBase,
      worktree: prepared.value.root,
      room,
      task: task.value,
      changeset,
      evidence,
      registryPath: join(home, '.local/state/ocean-coordination/leases.sqlite'),
      sandbox,
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
