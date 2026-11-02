import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CodingBackupInventory as Inventory } from '@runnets/domain';
import { codingPath } from './coding-git.js';
import { blockedName } from './backend.js';
export const graphHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type BackupFile = Inventory['changesets'][number]['files'][number];
export type Worktree = Inventory['worktrees'][number];
export const invalidInventory = (): never => {
  throw Error('invalid_coding_inventory');
};
export function recoveryFileKey(root: string, file: BackupFile) {
  const side = (image: BackupFile['before']) => image && [image.mode, image.sha256];
  return JSON.stringify([root, file.path, side(file.before), side(file.after)]);
}
function validSide(image: BackupFile['before']) {
  return (
    image === null ||
    (image &&
      ['100644', '100755'].includes(image.mode) &&
      typeof image.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(image.sha256))
  );
}
export function planRecoveryGraph(inventory: Inventory, managed: string) {
  const { hash, ...body } = inventory;
  if (
    body.format !== 1 ||
    graphHash(body) !== hash ||
    resolve(managed) !== managed ||
    managed === '/' ||
    body.tasks.length > 1000 ||
    body.worktrees.length > 1000 ||
    body.applications.length > 10000 ||
    body.changesets.length > 10000
  )
    return invalidInventory();
  const tasks = new Map(body.tasks.map((t) => [t.id, t])),
    trees = new Map(body.worktrees.map((t) => [t.taskId, t])),
    artifacts = new Map(body.changesets.map((a) => [a.hash, a]));
  if (
    tasks.size !== body.tasks.length ||
    trees.size !== body.worktrees.length ||
    artifacts.size !== body.changesets.length ||
    new Set(body.applications.map((a) => a.id)).size !== body.applications.length
  )
    return invalidInventory();
  const filesByHash = new Map<string, ReadonlyMap<string, BackupFile>>();
  return body.applications.map((application) => {
    const task = tasks.get(application.taskId),
      tree = trees.get(application.taskId),
      artifact = artifacts.get(application.changesetHash);
    if (!task || !tree || !artifact) return invalidInventory();
    const slot = graphHash([task.ownerId, task.projectRoot, task.id]);
    if (
      task.projectRoot !== resolve(task.projectRoot) ||
      task.projectRoot === '/' ||
      tree.gitCommonDir !== resolve(tree.gitCommonDir) ||
      tree.gitCommonDir === '/' ||
      tree.root !== join(managed, slot) ||
      tree.branch !== 'codex/ocean/' + slot ||
      tree.state !== 'ready' ||
      task.worktreeRoot !== tree.root ||
      tree.workspaceId !== task.workspaceId ||
      tree.projectRoot !== task.projectRoot ||
      tree.baseCommit !== task.baseCommit ||
      tree.lease.kind !== 'coding' ||
      tree.lease.ownerId !== task.ownerId ||
      tree.lease.projectRoot !== tree.root ||
      tree.lease.taskId !== task.id ||
      artifact.taskId !== task.id ||
      artifact.baseCommit !== task.baseCommit ||
      ![null, 2].includes(application.recoveryProtocol) ||
      artifact.files.length > 1000 ||
      application.files.length !== artifact.files.length
    )
      return invalidInventory();
    let files = filesByHash.get(artifact.hash);
    if (!files) {
      const checked = new Map<string, BackupFile>();
      for (const file of artifact.files) {
        codingPath(file.path);
        if (
          file.path.split('/').some(blockedName) ||
          checked.has(file.path) ||
          (!file.before && !file.after) ||
          !validSide(file.before) ||
          !validSide(file.after)
        )
          return invalidInventory();
        checked.set(file.path, file);
      }
      files = checked;
      filesByHash.set(artifact.hash, files);
    }
    if (application.files.some((file, i) => file.path !== artifact.files[i]!.path))
      return invalidInventory();
    const context = {
      ownerId: task.ownerId,
      taskId: task.id,
      applicationId: application.id,
      changesetHash: artifact.hash,
    };
    return { tree, application, files, context };
  });
}
export type RecoveryPlan = ReturnType<typeof planRecoveryGraph>[number];
