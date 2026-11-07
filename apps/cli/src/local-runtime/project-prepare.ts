import type { CodingWorktreeOwnerPort, RuntimeOwnerDecisions } from '@runnets/application';
import type { CodingAccess, CodingTask, CodingWorktree } from '@runnets/domain';
import type {
  CodingTaskPrepare,
  CodingTaskPreparation,
  PreparedCodingWorktree,
} from '@runnets/contracts';
import { GitCodingProject } from '@runnets/tools-node';
import type { Runtime } from '../runtime.js';
import { digest, ownerPreview } from './decision-preview.js';
type Authorized = Parameters<CodingWorktreeOwnerPort['confirm']>[0];
export const prepareReference = (q: CodingTaskPrepare) => {
  const key = 'prepare-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
  return { workspaceId: q.workspaceId, roomId: q.roomId, runId: key, decisionId: key };
};
export const preparePreview = (q: CodingTaskPrepare, authorized: Authorized) => {
  const { lease: _lease, ...task } = authorized.task;
  return { operation: 'prepare', request: q, authorized: { task, plan: authorized.plan } };
};
const safe = (w: CodingWorktree): PreparedCodingWorktree => ({
  workspaceId: w.workspaceId,
  taskId: w.taskId,
  projectRoot: w.projectRoot,
  baseCommit: w.baseCommit,
  root: w.root,
  branch: w.branch,
  gitCommonDir: w.gitCommonDir,
  state: 'ready',
});
type Preview = ReturnType<typeof preparePreview>;
/** Prepare-specific scope and proven result reads; owns no jobs or effects. */
export class ProjectPreparation {
  readonly runtime: Pick<Runtime, 'coding' | 'codingChanges' | 'conversationStore'>;
  readonly owner: RuntimeOwnerDecisions;
  constructor(
    runtime: Pick<Runtime, 'coding' | 'codingChanges' | 'conversationStore'>,
    owner: RuntimeOwnerDecisions,
  ) {
    this.runtime = runtime;
    this.owner = owner;
  }
  task(q: CodingTaskPrepare): CodingTask {
    const selected = this.runtime.coding.inspect(q.workspaceId, q.taskId);
    if (!selected.ok) throw Error(selected.error.code);
    const task = selected.value;
    const workspace = this.runtime.conversationStore?.atomic((tx) => tx.workspace());
    if (
      task.ownerRoomId !== q.roomId ||
      task.policyVersion !== q.expectedPolicyVersion ||
      workspace?.id !== q.workspaceId ||
      workspace.root !== task.projectRoot
    )
      throw Error('coding_denied');
    return task;
  }
  access(q: CodingTaskPrepare): CodingAccess {
    const task = this.task(q);
    return {
      taskId: task.id,
      workspaceId: q.workspaceId,
      roomId: q.roomId,
      botId: task.devBotId,
      policyVersion: q.expectedPolicyVersion,
      capability: 'project_read',
    };
  }
  async current(q: CodingTaskPrepare, authorized: Authorized): Promise<boolean> {
    const task = this.task(q);
    if (
      ownerPreview(preparePreview(q, { task, plan: authorized.plan })) !==
      ownerPreview(preparePreview(q, authorized))
    )
      return false;
    const proof = await this.runtime.codingChanges.prepared(this.access(q));
    if (!proof.ok || proof.value) return false;
    const project = await new GitCodingProject().inspect(task.projectRoot);
    return (
      project.clean && project.root === task.projectRoot && project.baseCommit === task.baseCommit
    );
  }
  async existing(
    q: CodingTaskPrepare,
    active: (id: string) => boolean,
  ): Promise<CodingTaskPreparation | null> {
    const ref = prepareReference(q),
      stored = this.owner.store.find(ref);
    if (!stored) {
      if (this.owner.store.has(ref.decisionId)) throw Error('request_conflict');
      const proof = await this.runtime.codingChanges.prepared(this.access(q));
      if (!proof.ok) throw Error(proof.error.code);
      return proof.value
        ? { status: 'existing', decision: null, worktree: safe(proof.value) }
        : null;
    }
    const text = this.owner.store.preview(ref);
    if (
      !text ||
      stored.kind !== 'project-setup' ||
      digest(text) !== stored.bindingDigest ||
      text.length !== stored.previewLength
    )
      throw Error('preparation_unavailable');
    const p = JSON.parse(text) as Preview;
    if (p.operation !== 'prepare' || ownerPreview(p.request) !== ownerPreview(q))
      throw Error('request_conflict');
    const decision = this.owner.get(ref);
    const proof = await this.runtime.codingChanges.prepared(this.access(q));
    // A decision alone never proves an effect; pending/uncertain records remain unconfirmed.
    if (decision.status === 'allowed' && proof.ok && proof.value) {
      const task = this.task(q),
        worktree = proof.value;
      const expected = p.authorized;
      const { lease: _lease, ...currentTask } = task;
      if (
        ownerPreview(currentTask) !==
          ownerPreview({ ...expected.task, worktreeRoot: worktree.root }) ||
        worktree.root !== expected.plan.root ||
        worktree.branch !== expected.plan.branch ||
        worktree.gitCommonDir !== expected.plan.gitCommonDir
      )
        throw Error('preparation_unavailable');
      return { status: 'prepared', decision, worktree: safe(worktree) };
    }
    return {
      status:
        decision.status === 'allowed' && !active(ref.decisionId) ? 'unconfirmed' : decision.status,
      decision,
      worktree: null,
    };
  }
}
