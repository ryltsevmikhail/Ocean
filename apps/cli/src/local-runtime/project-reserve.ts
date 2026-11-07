import type { CodingOwnerPort, RuntimeOwnerDecisions, StartCodingTask } from '@runnets/application';
import {
  isCodingTaskReserve,
  type CodingTaskReserve,
  type CodingTaskReservation,
} from '@runnets/contracts';
import { GitCodingProject } from '@runnets/tools-node';
import type { Runtime } from '../runtime.js';
import { readCodingProjects } from '../ocean/coding-projects.js';
import { digest, ownerPreview } from './decision-preview.js';
import type { RuntimeReply } from './queries.js';
type Authorized = Parameters<CodingOwnerPort['confirm']>[0];
type Preview = {
  operation: 'reserve';
  request: CodingTaskReserve;
  input: StartCodingTask;
  authorized: Authorized;
};
type Job = { binding: string; acknowledged: Promise<RuntimeReply>; done: Promise<void> };
const normalize = (q: CodingTaskReserve): CodingTaskReserve => ({
  workspaceId: q.workspaceId,
  projectId: q.projectId,
  requestId: q.requestId,
  taskId: q.taskId,
  ownerRoomId: q.ownerRoomId,
  devBotId: q.devBotId,
  reviewRoomId: q.reviewRoomId,
  reviewBotId: q.reviewBotId,
});
const requestKey = (q: CodingTaskReserve) =>
  'reserve-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
const reference = (q: CodingTaskReserve) => ({
  workspaceId: q.workspaceId,
  roomId: q.ownerRoomId,
  runId: requestKey(q),
  decisionId: requestKey(q),
});
/** One host-owned reserve lane. A durable card never reinstalls a continuation. */
export class RuntimeProjectReserve {
  readonly #jobs = new Map<string, Job>();
  readonly #closing = new AbortController();
  #failure = false;
  readonly profile: string;
  readonly owner: RuntimeOwnerDecisions;
  readonly runtime: Pick<Runtime, 'coding' | 'conversations' | 'conversationStore'>;
  constructor(
    profile: string,
    runtime: Pick<Runtime, 'coding' | 'conversations' | 'conversationStore'>,
    owner: RuntimeOwnerDecisions,
  ) {
    this.profile = profile;
    this.runtime = runtime;
    this.owner = owner;
  }
  async dispatch(params: Record<string, unknown>, draining = false): Promise<RuntimeReply> {
    try {
      if (draining || this.#closing.signal.aborted) throw Error('runtime_draining');
      if (!isCodingTaskReserve(params)) throw Error('invalid_params');
      const q = normalize(params),
        ref = reference(q),
        binding = ownerPreview(q);
      const existing = this.#existing(q);
      if (existing) return { result: existing };
      const active = this.#jobs.get(ref.decisionId);
      if (active) {
        if (active.binding !== binding) throw Error('request_conflict');
        return active.acknowledged;
      }
      if (this.#jobs.size >= 2) throw Error('query_limit');
      let acknowledge!: (reply: RuntimeReply) => void;
      const acknowledged = new Promise<RuntimeReply>((resolve) => {
        acknowledge = resolve;
      });
      // Start on the next microtask, after the keyed job owns the admission slot.
      let opened = false;
      const done = Promise.resolve()
        .then(async () => {
          const input = await this.#input(q);
          if (this.#closing.signal.aborted) throw Error('runtime_draining');
          const result = await this.runtime.coding.start(input, {
            confirm: async (authorized) => {
              if (this.#closing.signal.aborted) return false;
              const preview = ownerPreview({ operation: 'reserve', request: q, input, authorized });
              if (preview.length > 65536) throw Error('query_limit');
              const createdAt = this.owner.now();
              const card = {
                ...ref,
                kind: 'project-setup' as const,
                status: 'pending' as const,
                version: 1,
                bindingDigest: digest(preview),
                previewLength: preview.length,
                createdAt,
                expiresAt: createdAt + 300000,
              };
              opened = true;
              const wait = this.owner.open(card, preview, this.#closing.signal, async () => {
                if (
                  this.#closing.signal.aborted ||
                  ownerPreview(await this.#input(q)) !== ownerPreview(input)
                )
                  return false;
                const project = await new GitCodingProject().inspect(input.projectRoot);
                const workspace = this.runtime.conversationStore?.atomic((tx) => tx.workspace());
                const member = (roomId: string, botId: string) => {
                  const members = this.runtime.conversations.members(q.workspaceId, roomId);
                  return members.ok && members.value.some((bot) => bot.id === botId);
                };
                return (
                  !this.#closing.signal.aborted &&
                  project.clean &&
                  project.root === authorized.projectRoot &&
                  project.baseCommit === authorized.baseCommit &&
                  workspace?.id === q.workspaceId &&
                  workspace.root === project.root &&
                  member(q.ownerRoomId, q.devBotId) &&
                  member(q.reviewRoomId, q.reviewBotId)
                );
              });
              acknowledge({ result: { status: 'pending', decision: card, task: null } });
              return (await wait) === 'allowed' && !this.#closing.signal.aborted;
            },
          });
          // An early service refusal has no card. After confirmation the card/receipt owns replay.
          if (!result.ok) acknowledge({ error: { code: result.error.code } });
          else {
            const existing = this.#existing(q);
            acknowledge(existing ? { result: existing } : { error: { code: 'request_conflict' } });
          }
        })
        .catch((error: unknown) => {
          if (opened) this.#failure = true;
          acknowledge({
            error: {
              code:
                error instanceof Error && /^[a-z_]+$/.test(error.message)
                  ? error.message
                  : 'reservation_unavailable',
            },
          });
        })
        .finally(() => this.#jobs.delete(ref.decisionId));
      this.#jobs.set(ref.decisionId, { binding, acknowledged, done });
      return acknowledged;
    } catch (error) {
      return {
        error: {
          code:
            error instanceof Error && /^[a-z_]+$/.test(error.message)
              ? error.message
              : 'reservation_unavailable',
        },
      };
    }
  }
  async #input(q: CodingTaskReserve): Promise<StartCodingTask> {
    const project = (await readCodingProjects(this.profile)).find((p) => p.id === q.projectId);
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
  #existing(q: CodingTaskReserve): CodingTaskReservation | null {
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
        decision.status === 'allowed' && !this.#jobs.has(ref.decisionId)
          ? 'unconfirmed'
          : decision.status,
      decision,
      task: null,
    };
  }
  async drain(): Promise<'settled' | 'uncertain'> {
    this.#closing.abort();
    await Promise.all([...this.#jobs.values()].map((j) => j.done));
    return this.#failure ? 'uncertain' : 'settled';
  }
}
