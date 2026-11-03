import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodingBackupInventory, CodingWorktree } from '@runnets/domain';
export function partialFixture(shape = 'no-checkout', objectFormat = 'sha1', separate = false) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-partial-'));
  const project = join(outer, 'project'),
    managed = join(outer, 'managed'),
    home = join(outer, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project);
  fs.mkdirSync(managed, { mode: 0o700 });
  const env = {
    PATH: '/usr/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim();
  git(
    project,
    'init',
    '-q',
    '--object-format=' + objectFormat,
    ...(separate ? ['--separate-git-dir=' + join(outer, 'common')] : []),
  );
  fs.writeFileSync(join(project, 'a'), 'base-a');
  fs.writeFileSync(join(project, 'b'), 'base-b');
  git(project, 'add', '.');
  git(
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  const baseCommit = git(project, 'rev-parse', 'HEAD');
  const slot = createHash('sha256')
    .update(JSON.stringify(['owner', project, 'task']))
    .digest('hex');
  const root = join(managed, slot),
    branch = 'codex/ocean/' + slot,
    common = separate ? join(outer, 'common') : join(project, '.git');
  if (shape !== 'planned')
    git(project, 'worktree', 'add', '--no-checkout', '-b', branch, root, baseCommit);
  if (shape === 'partial' || shape === 'indexed') {
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(join(root, 'a'), Buffer.from([0, 255, 1]), { mode: 0o755 });
  }
  if (shape === 'indexed') git(root, 'read-tree', baseCommit);
  if (shape === 'root-absent' || shape === 'branch-only') fs.rmSync(root, { recursive: true });
  if (shape === 'branch-only') fs.rmSync(join(common, 'worktrees'), { recursive: true });
  const worktree: CodingWorktree = {
    taskId: 'task',
    workspaceId: 'ws',
    projectRoot: project,
    baseCommit,
    root,
    branch,
    gitCommonDir: common,
    state: 'preparing',
    lease: {
      ownerId: 'owner',
      projectRoot: root,
      taskId: 'task',
      kind: 'coding',
      token: 'token',
      requestId: 'prepare',
      binding: 'binding',
    },
  };
  const inventory = () => {
    const body = {
      format: 1 as const,
      tasks: [
        {
          id: 'task',
          workspaceId: 'ws',
          projectRoot: project,
          baseCommit,
          worktreeRoot: root,
          ownerId: 'owner',
          status: 'reserved' as const,
          policyVersion: 1 as const,
          policy: {
            version: 1 as const,
            devCapabilities: [],
            reviewCapabilities: ['changeset_read'] as const,
            testPresets: [],
          },
        },
      ],
      worktrees: [worktree],
      changesets: [],
      applications: [],
    };
    return {
      ...body,
      hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    } satisfies CodingBackupInventory;
  };
  return {
    outer,
    project,
    managed,
    home,
    env,
    git,
    root,
    slot,
    common,
    admin: join(common, 'worktrees', slot),
    worktree,
    inventory,
    close: () => fs.rmSync(outer, { recursive: true, force: true }),
  };
}
