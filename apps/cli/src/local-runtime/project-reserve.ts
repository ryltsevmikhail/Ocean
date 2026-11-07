import type { ProviderActivationPort, RuntimeOwnerDecisions } from '@runnets/application';
import {
  CODING_APPLY_REQUEST,
  CODING_REVIEW_REQUEST,
  isCodingApplyQuery,
  type CodingApplyQuery,
  isCodingReviewQuery,
  type CodingReviewQuery,
  isCodingTaskReserve,
  isCodingTaskPrepare,
  type CodingTaskReserve,
  type CodingTaskPrepare,
  type CodingTaskPreparation,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { digest, ownerPreview } from './decision-preview.js';
import type { RuntimeReply } from './queries.js';
import { ProjectReservation } from './project-reservation.js';
import { ProjectPreparation, prepareReference, preparePreview } from './project-prepare.js';
import { ProjectReview, reviewReference } from './project-review.js';
import { ProjectApply, applyReference } from './project-apply.js';
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
const normalizePrepare = (q: CodingTaskPrepare): CodingTaskPrepare => ({
  workspaceId: q.workspaceId,
  roomId: q.roomId,
  taskId: q.taskId,
  requestId: q.requestId,
  expectedPolicyVersion: q.expectedPolicyVersion,
});
const normalizeReview = (q: CodingReviewQuery): CodingReviewQuery => ({
  workspaceId: q.workspaceId,
  roomId: q.roomId,
  taskId: q.taskId,
  requestId: q.requestId,
  hash: q.hash,
});
const normalizeApply = (q: CodingApplyQuery): CodingApplyQuery => ({
  workspaceId: q.workspaceId,
  roomId: q.roomId,
  taskId: q.taskId,
  requestId: q.requestId,
  expectedBase: q.expectedBase,
  changesetHash: q.changesetHash,
  reviewRequestId: q.reviewRequestId,
});
type ProjectSetupOperation = 'reserve' | 'prepare' | 'review' | 'apply';
export function projectSetupOperation(method: string): ProjectSetupOperation | undefined {
  switch (method) {
    case 'coding.tasks.reserve':
      return 'reserve';
    case 'coding.tasks.prepare':
      return 'prepare';
    case CODING_REVIEW_REQUEST:
      return 'review';
    case CODING_APPLY_REQUEST:
      return 'apply';
    default:
      return undefined;
  }
}
type ProjectRuntime = Pick<
  Runtime,
  | 'coding'
  | 'codingChanges'
  | 'conversations'
  | 'conversationStore'
  | 'codingReview'
  | 'codingApply'
  | 'service'
>;
const reference = (q: CodingTaskReserve) => {
  const key = 'reserve-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
  return { workspaceId: q.workspaceId, roomId: q.ownerRoomId, runId: key, decisionId: key };
};
/** One bounded project lane for reserve, prepare, review and apply. Durable cards never reinstall continuations. */
export class RuntimeProjectReserve {
  readonly #jobs = new Map<string, Job>();
  readonly #reads = new Map<
    string,
    {
      binding: string;
      value: Promise<CodingTaskPreparation | null>;
    }
  >();
  readonly #closing = new AbortController();
  #failure = false;
  readonly #reserve: ProjectReservation;
  readonly #prepare: ProjectPreparation;
  readonly #review: ProjectReview | undefined;
  readonly #apply: ProjectApply;
  readonly profile: string;
  readonly runtime: ProjectRuntime;
  readonly owner: RuntimeOwnerDecisions;
  constructor(
    profile: string,
    runtime: ProjectRuntime,
    owner: RuntimeOwnerDecisions,
    resolver?: ProviderActivationPort,
  ) {
    this.profile = profile;
    this.runtime = runtime;
    this.owner = owner;
    this.#reserve = new ProjectReservation(profile, runtime, owner);
    this.#prepare = new ProjectPreparation(runtime, owner);
    this.#review = resolver && new ProjectReview(runtime, owner, resolver);
    this.#apply = new ProjectApply(runtime, owner);
  }
  async dispatch(
    params: Record<string, unknown>,
    draining = false,
    operation: ProjectSetupOperation = 'reserve',
  ): Promise<RuntimeReply> {
    try {
      if (draining || this.#closing.signal.aborted) throw Error('runtime_draining');
      const reserve =
        operation === 'reserve' && isCodingTaskReserve(params) ? normalize(params) : null;
      const prepare =
        operation === 'prepare' && isCodingTaskPrepare(params) ? normalizePrepare(params) : null;
      const review =
        operation === 'review' && isCodingReviewQuery(params) ? normalizeReview(params) : null;
      const apply =
        operation === 'apply' && isCodingApplyQuery(params) ? normalizeApply(params) : null;
      if (!reserve && !prepare && !review && !apply) throw Error('invalid_params');
      if (review && !this.#review) throw Error('review_unavailable');
      const ref = reserve
          ? reference(reserve)
          : prepare
            ? prepareReference(prepare)
            : review
              ? reviewReference(review)
              : applyReference(apply!),
        binding = ownerPreview(reserve ?? prepare ?? review ?? apply);
      const activeJob = (id: string) => this.#jobs.has(id);
      const existing = () =>
        reserve
          ? this.#reserve.existing(reserve, activeJob)
          : prepare
            ? this.#prepare.existing(prepare, activeJob)
            : review
              ? this.#review!.existing(review, activeJob)
              : this.#apply.existing(apply!, activeJob);
      const previous = prepare ? await this.#read(prepare) : await existing();
      if (this.#closing.signal.aborted) throw Error('runtime_draining');
      if (previous) return { result: previous };
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
      let opened = false;
      const confirm = async (value: unknown, current: () => Promise<boolean>) => {
        if (this.#closing.signal.aborted) return false;
        const preview = ownerPreview(value);
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
        const pending = reserve
          ? { status: 'pending', decision: card, task: null }
          : prepare
            ? { status: 'pending', decision: card, worktree: null }
            : review
              ? this.#review!.pending(card, value)
              : { state: 'pending', decision: card, receipt: null };
        opened = true;
        const wait = this.owner.open(
          card,
          preview,
          this.#closing.signal,
          async () =>
            !this.#closing.signal.aborted && (await current()) && !this.#closing.signal.aborted,
        );
        acknowledge({ result: pending });
        return (await wait) === 'allowed' && !this.#closing.signal.aborted;
      };
      const done = Promise.resolve()
        .then(async () => {
          const uncertain = () => {
            this.#failure = true;
          };
          const result = reserve
            ? await (async () => {
                const input = await this.#reserve.input(reserve);
                if (this.#closing.signal.aborted) throw Error('runtime_draining');
                return this.runtime.coding.start(input, {
                  confirm: (authorized) =>
                    confirm({ operation: 'reserve', request: reserve, input, authorized }, () =>
                      this.#reserve.current(reserve, input, authorized),
                    ),
                });
              })()
            : prepare
              ? await this.runtime.codingChanges.prepare(this.#prepare.access(prepare), {
                  confirm: (authorized) =>
                    confirm(preparePreview(prepare, authorized), () =>
                      this.#prepare.current(prepare, authorized),
                    ),
                })
              : review
                ? await this.#review!.run(review, this.#closing.signal, confirm, uncertain)
                : await this.#apply.run(apply!, confirm, uncertain);
          if (!result.ok) acknowledge({ error: { code: result.error.code } });
          else if (!review && !apply) {
            const previous = await existing();
            acknowledge(previous ? { result: previous } : { error: { code: 'request_conflict' } });
          }
        })
        .catch((error: unknown) => {
          if (opened) this.#failure = true;
          acknowledge(this.#error(error));
        })
        .finally(() => this.#jobs.delete(ref.decisionId));
      this.#jobs.set(ref.decisionId, { binding, acknowledged, done });
      return acknowledged;
    } catch (error) {
      return this.#error(error);
    }
  }
  /** Read slots are separate so pending owner jobs cannot starve their result reads. */
  async #read(q: CodingTaskPrepare): Promise<CodingTaskPreparation | null> {
    const key = prepareReference(q).decisionId,
      binding = ownerPreview(q);
    const active = this.#reads.get(key);
    if (active) {
      if (active.binding !== binding) throw Error('request_conflict');
      return active.value;
    }
    if (this.#reads.size >= 2) throw Error('query_limit');
    const read = this.#prepare.existing(q, (id) => this.#jobs.has(id));
    this.#reads.set(key, { binding, value: read });
    try {
      return await read;
    } finally {
      this.#reads.delete(key);
    }
  }
  #error(error: unknown): RuntimeReply {
    return {
      error: {
        code:
          error instanceof Error && /^[a-z_]+$/.test(error.message)
            ? error.message
            : 'reservation_unavailable',
      },
    };
  }
  async drain(): Promise<'settled' | 'uncertain'> {
    this.#closing.abort();
    await Promise.all([...this.#jobs.values()].map((j) => j.done));
    await Promise.allSettled([...this.#reads.values()].map((r) => r.value));
    return this.#failure ? 'uncertain' : 'settled';
  }
}
