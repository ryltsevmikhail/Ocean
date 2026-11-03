import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodingBackupInventory as Inventory } from '@runnets/domain';
// eslint-disable-next-line no-restricted-imports -- Same-package host fixture, outside compiled src.
import { applyCodingFile } from '../src/coding-apply-file.js';
// eslint-disable-next-line no-restricted-imports -- Exercise the actual historical writer.
import { withCodingApplyRecovery } from '../src/coding-apply-scope.js';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const content = (text: string) => ({ text, mode: '100644' as const, sha256: digest(text) });
export function graphFixture(count = 1) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-recovery-graph-')),
    managed = join(outer, 'worktrees');
  fs.mkdirSync(managed, { mode: 0o700 });
  const tasks: Inventory['tasks'][number][] = [],
    worktrees: Inventory['worktrees'][number][] = [],
    changesets: Inventory['changesets'][number][] = [],
    applications: Inventory['applications'][number][] = [];
  const change = { path: 'file', before: content('old'), after: content('new') };
  for (let i = 0; i < count; i++) {
    const id = 'task' + i,
      project = join(outer, 'project' + i);
    fs.mkdirSync(project);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', project, ...args], {
        encoding: 'utf8',
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
          PATH: '/usr/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          HOME: outer,
        },
      }).trim();
    git('init', '-q');
    fs.writeFileSync(join(project, 'file'), 'old');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'base');
    const baseCommit = git('rev-parse', 'HEAD'),
      slot = digest(JSON.stringify(['owner', project, id])),
      root = join(managed, slot),
      branch = 'codex/ocean/' + slot;
    git('worktree', 'add', '-qb', branch, root);
    fs.chmodSync(root, 0o700);
    tasks.push({
      id,
      projectRoot: project,
      workspaceId: 'ws',
      worktreeRoot: root,
      ownerId: 'owner',
      status: 'reserved',
      policyVersion: 1,
      policy: {
        version: 1,
        devCapabilities: [],
        reviewCapabilities: ['changeset_read'],
        testPresets: [],
      },
      baseCommit,
    });
    worktrees.push({
      root,
      branch,
      baseCommit,
      taskId: id,
      workspaceId: 'ws',
      projectRoot: project,
      gitCommonDir: join(project, '.git'),
      state: 'ready',
      lease: {
        kind: 'coding',
        ownerId: 'owner',
        taskId: id,
        projectRoot: root,
        token: 'test',
        binding: 'test',
        requestId: 'prepare',
      },
    });
    changesets.push({
      hash: digest(id),
      taskId: id,
      baseCommit,
      beforeTreeHash: digest('before'),
      afterTreeHash: digest('after'),
      files: [
        {
          path: 'file',
          before: { mode: '100644', sha256: digest('old') },
          after: { mode: '100644', sha256: digest('new') },
        },
      ],
    });
  }
  const add = (
    id: string,
    task = 0,
    protocol: 2 | null = null,
    status: 'completed' | 'uncertain' = 'completed',
  ) => {
    const application = {
      id,
      taskId: tasks[task]!.id,
      changesetHash: changesets[task]!.hash,
      recoveryProtocol: protocol,
      status,
      files: [{ path: 'file', status }],
    };
    applications.push(application);
    return application;
  };
  const legacy = (task = 0, old = 'old', root = tasks[task]!.projectRoot) => {
    const dir = join(worktrees[task]!.gitCommonDir, 'ocean-apply-recovery');
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(join(root, 'file'), old);
    const before = fs.readdirSync(dir);
    applyCodingFile(root, dir, { ...change, before: content(old) });
    return join(
      dir,
      fs.readdirSync(dir).find((n) => !before.includes(n) && n.endsWith('.json'))!,
    );
  };
  const scoped = (app: Inventory['applications'][number], headerOnly = false) => {
    const i = tasks.findIndex((t) => t.id === app.taskId),
      root = tasks[i]!.projectRoot;
    const context = {
      taskId: app.taskId,
      ownerId: 'owner',
      applicationId: app.id,
      changesetHash: app.changesetHash,
    };
    fs.writeFileSync(join(root, 'file'), 'old');
    let leaf = '';
    withCodingApplyRecovery(worktrees[i]!.gitCommonDir, root, context, (scope) => {
      leaf = dirname(scope.path);
      if (!headerOnly) applyCodingFile(root, scope, change);
    });
    if (headerOnly) fs.rmdirSync(join(leaf, 'files'));
    return leaf;
  };
  const inventory = () => {
    const body = { format: 1 as const, tasks, worktrees, changesets, applications };
    return { ...body, hash: digest(JSON.stringify(body)) };
  };
  return {
    outer,
    managed,
    tasks,
    worktrees,
    applications,
    changesets,
    inventory,
    add,
    legacy,
    scoped,
    close: () => fs.rmSync(outer, { recursive: true, force: true }),
  };
}
