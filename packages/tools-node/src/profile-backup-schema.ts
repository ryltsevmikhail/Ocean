import { validDesktopBindingShape } from './desktop-identity.js';
import type { ProfileBackupAssetCatalog } from './profile-backup-types.js';
import { validCodingBackupPolicy } from '@runnets/domain';
const bad = (): never => {
  throw Error('invalid_profile_backup');
};
function keys(value: unknown, required: string, optional: string[] = []): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const names = Object.keys(value),
    expected = required.split(',');
  if (
    expected.some((k) => !names.includes(k)) ||
    names.some((k) => !expected.includes(k) && !optional.includes(k))
  )
    return bad();
}
function unique(values: readonly unknown[], limit: number): void {
  if (!Array.isArray(values) || values.length > limit || new Set(values).size !== values.length)
    return bad();
}
/** Strict portable shapes precede semantic cross-reference checks and archive body decoding. */
export function validateProfileCatalogShape(c: ProfileBackupAssetCatalog): void {
  keys(c, 'format,inventory,desktopInventory,worktrees,recovery,dependencies,desktop,git,hash', [
    'plugins',
  ]);
  if (c.plugins !== undefined) {
    keys(c.plugins, 'format,inventoryHash,files,hash');
    if (
      c.plugins.format !== 1 ||
      typeof c.plugins.inventoryHash !== 'string' ||
      !/^([a-f0-9]{64})?$/.test(c.plugins.inventoryHash) ||
      !Array.isArray(c.plugins.files) ||
      c.plugins.files.length > 64
    )
      return bad();
    for (const file of c.plugins.files) keys(file, 'pluginId,version,sha256,bytes');
  }
  keys(c.inventory, 'format,tasks,worktrees,changesets,applications,hash');
  unique(
    c.inventory.tasks.map((t) => t.id),
    1000,
  );
  unique(
    c.inventory.worktrees.map((t) => t.taskId),
    1000,
  );
  unique(
    c.inventory.changesets.map((t) => t.hash),
    10000,
  );
  unique(
    c.inventory.applications.map((t) => t.id),
    10000,
  );
  for (const task of c.inventory.tasks) {
    keys(
      task,
      'id,workspaceId,policyVersion,policy,projectRoot,baseCommit,worktreeRoot,ownerId,status',
    );
    if (!validCodingBackupPolicy(task.policyVersion, task.policy)) return bad();
  }
  for (const tree of c.inventory.worktrees) {
    keys(tree, 'root,branch,gitCommonDir,taskId,projectRoot,baseCommit,workspaceId,state,lease');
    keys(tree.lease, 'kind,ownerId,taskId,projectRoot,token,binding,requestId');
  }
  for (const artifact of c.inventory.changesets) {
    keys(artifact, 'hash,taskId,baseCommit,beforeTreeHash,afterTreeHash,files');
    unique(
      artifact.files.map((f) => f.path),
      1000,
    );
    for (const file of artifact.files) {
      keys(file, 'path,before,after');
      for (const side of [file.before, file.after]) if (side !== null) keys(side, 'mode,sha256');
    }
  }
  for (const application of c.inventory.applications) {
    keys(application, 'id,taskId,changesetHash,status,recoveryProtocol,files');
    unique(
      application.files.map((f) => f.path),
      1000,
    );
    for (const file of application.files) keys(file, 'path,status');
  }
  keys(c.worktrees, 'format,inventoryHash,worktrees,hash');
  unique(
    c.worktrees.worktrees.map((t) => t.slot),
    1000,
  );
  for (const tree of c.worktrees.worktrees)
    keys(
      tree,
      'taskId,slot,state,presence,treeHash,indexSha256,packSha256' +
        (tree.presence === 'partial' ? ',administrationHash' : ''),
    );
  unique(
    c.git.map((g) => g.slot),
    1000,
  );
  for (const git of c.git) keys(git, 'slot,kind,sha256');
  keys(c.recovery, 'format,inventoryHash,applications,legacy,hash');
  unique(
    c.recovery.applications.map((a) => a.id),
    10000,
  );
  unique(
    c.recovery.legacy.map((a) => a.slot),
    10000,
  );
  for (const application of c.recovery.applications) {
    keys(
      application,
      'id,taskId,changesetHash,slot,status,declaredProtocol,observedProtocol,presence,records,unknown,manifestHash',
    );
    unique(
      application.records.map((r) => r.id),
      10000,
    );
    for (const record of application.records)
      keys(record, 'id,root,path,status,nextOpaque,original', ['publicationLink']);
  }
  for (const legacy of c.recovery.legacy) {
    keys(legacy, 'slot,manifestHash,records');
    unique(
      legacy.records.map((r) => r.id),
      10000,
    );
    for (const record of legacy.records)
      keys(record, 'id,root,path,status,nextOpaque,original,candidateApplicationIds,ambiguous');
  }
  keys(c.dependencies, 'format,inventoryHash,configuration,projects,tasks,hash');
  keys(c.dependencies.configuration, 'presence,bytes,sha256');
  unique(
    c.dependencies.tasks.map((t) => t.taskId),
    1000,
  );
  for (const task of c.dependencies.tasks) {
    keys(task, 'taskId,projectId,policyHash,treeHash,treeSelection,mappings,virtualHash,links');
    for (const mapping of task.mappings) keys(mapping, 'slot,source,target,file,manifestHash');
    for (const link of task.links) keys(link, 'path,target');
  }
  if (c.desktop) keys(c.desktop, 'format,inventory,manifest,hash');
  keys(c.desktopInventory, 'format,binding,rooms,messages,operations,uploads');
  unique(c.desktopInventory.rooms, 10000);
  unique(
    c.desktopInventory.messages.map((m) => m.id),
    10000,
  );
  unique(
    c.desktopInventory.operations.map((o) => o.id),
    10000,
  );
  unique(
    c.desktopInventory.uploads.map((u) => u.id),
    10000,
  );
  if (c.desktopInventory.binding && !validDesktopBindingShape(c.desktopInventory.binding)) bad();
  for (const message of c.desktopInventory.messages)
    keys(message, 'id,roomId,requestId,body,requestBinding,requestReply');
  for (const operation of c.desktopInventory.operations) keys(operation, 'id,binding,state,result');
  for (const upload of c.desktopInventory.uploads) keys(upload, 'id,room,name,bytes,sha256,data');
}
