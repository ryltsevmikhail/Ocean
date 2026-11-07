import type { CodingOwnerPort, RuntimeOwnerDecisions, StartCodingTask } from '@runnets/application';
import { type CodingTaskReserve, type CodingTaskReservation } from '@runnets/contracts';
import { GitCodingProject } from '@runnets/tools-node';
import type { Runtime } from '../runtime.js';
import { readCodingProjects } from '../ocean/coding-projects.js';
import { digest, ownerPreview } from './decision-preview.js';
import { ProjectPreCardRefusal } from './project-pre-card-refusal.js';
type Authorized = Parameters<CodingOwnerPort['confirm']>[0];
type Preview = {
  operation: 'reserve';
  request: CodingTaskReserve;
  input: StartCodingTask;
  authorized: Authorized;
};
const requestKey = (q: CodingTaskReserve) =>
  'reserve-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
const reference = (q: CodingTaskReserve) => ({
  workspaceId: q.workspaceId,
  roomId: q.ownerRoomId,
  runId: requestKey(q),
  decisionId: requestKey(q),
});
/** Reserve-specific bindings and receipt reads for the shared setup lane. */
export class ProjectReservation {
  readonly profile: string;
  readonly runtime: Pick<Runtime, 'coding' | 'conversations' | 'conversationStore'>;
  readonly owner: RuntimeOwnerDecisions;
  constructor(
    profile: string,
    runtime: Pick<Runtime, 'coding' | 'conversations' | 'conversationStore'>,
    owner: RuntimeOwnerDecisions,
  ) {
    this.profile = profile;
    this.runtime = runtime;
    this.owner = owner;
  }
  async input(q: CodingTaskReserve): Promise<StartCodingTask> {
    const projects = await readCodingProjects(this.profile).catch(() => {
      throw new ProjectPreCardRefusal('catalog_unavailable');
    });
    const project = projects.find((p) => p.id === q.projectId);
    if (!project) throw Error('unknown_project');
    return {
      taskId: q.taskId,
      requestId: reference(q).decisionId,
      workspaceId: q.workspaceId,
      projectRoot: project.root,
      ownerRoomId: q.ownerRoomId,
      devBotId: q.devBotId,
      reviewRoomId: q.reviewRoomId,
      reviewBotId: q.reviewBotId,
      devCapabilities: ['project_read', 'propose_write', 'run_test_preset'],
      testPresets: project.testPresets,
    };
  }
  existing(q: CodingTaskReserve, active: (id: string) => boolean): CodingTaskReservation | null {
    const ref = reference(q),
      stored = this.owner.store.find(ref);
    if (!stored) {
      if (this.owner.store.has(ref.decisionId)) throw Error('request_conflict');
      return null;
    }
    const text = this.owner.store.preview(ref);
    if (
      !text ||
      stored.kind !== 'project-setup' ||
      digest(text) !== stored.bindingDigest ||
      text.length !== stored.previewLength
    )
      throw Error('reservation_unavailable');
    const p = JSON.parse(text) as Preview;
    if (p.operation !== 'reserve' || ownerPreview(p.request) !== ownerPreview(q))
      throw Error('request_conflict');
    const decision = this.owner.get(ref);
    const receipt = this.runtime.coding.reservationReceipt(p.input);
    if (!receipt.ok) throw Error(receipt.error.code);
    const task = receipt.value;
    if (task) {
      if (
        decision.status !== 'allowed' ||
        task.id !== q.taskId ||
        task.baseCommit !== p.authorized.baseCommit ||
        task.projectRoot !== p.authorized.projectRoot ||
        task.workspaceId !== q.workspaceId ||
        task.ownerRoomId !== q.ownerRoomId ||
        task.devBotId !== q.devBotId ||
        task.reviewRoomId !== q.reviewRoomId ||
        task.reviewBotId !== q.reviewBotId
      )
        throw Error('reservation_unavailable');
      return {
        status: 'reserved',
        decision,
        task: {
          id: task.id,
          status: task.status,
          ownerRoomId: task.ownerRoomId,
          devBotId: task.devBotId,
          reviewRoomId: task.reviewRoomId,
          reviewBotId: task.reviewBotId,
        },
      };
    }
    return {
      status:
        decision.status === 'allowed' && !active(ref.decisionId) ? 'unconfirmed' : decision.status,
      decision,
      task: null,
    };
  }
  async current(q: CodingTaskReserve, input: StartCodingTask, authorized: Authorized) {
    if (ownerPreview(await this.input(q)) !== ownerPreview(input)) return false;
    const project = await new GitCodingProject().inspect(input.projectRoot);
    const workspace = this.runtime.conversationStore?.atomic((tx) => tx.workspace());
    const member = (roomId: string, botId: string) => {
      const members = this.runtime.conversations.members(q.workspaceId, roomId);
      return members.ok && members.value.some((bot) => bot.id === botId);
    };
    return (
      project.clean &&
      project.root === authorized.projectRoot &&
      project.baseCommit === authorized.baseCommit &&
      workspace?.id === q.workspaceId &&
      workspace.root === project.root &&
      member(q.ownerRoomId, q.devBotId) &&
      member(q.reviewRoomId, q.reviewBotId)
    );
  }
}
