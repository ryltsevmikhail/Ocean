import type { RuntimeOwnerDecisions } from '@runnets/application';
import {
  isCodingTaskReserve,
  isCodingTaskPrepare,
  type CodingTaskReserve,
  type CodingTaskPrepare,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { digest, ownerPreview } from './decision-preview.js';
import type { RuntimeReply } from './queries.js';
import { ProjectReservation } from './project-reservation.js';
import { ProjectPreparation, prepareReference, preparePreview } from './project-prepare.js';
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
const reference = (q: CodingTaskReserve) => {
  const key = 'reserve-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
  return { workspaceId: q.workspaceId, roomId: q.ownerRoomId, runId: key, decisionId: key };
};
/** One bounded setup lane for reserve and prepare. Durable cards never reinstall continuations. */
export class RuntimeProjectReserve {
  readonly #jobs = new Map<string, Job>();
  readonly #closing = new AbortController();
  #failure = false;
  readonly #reserve: ProjectReservation;
  readonly #prepare: ProjectPreparation;
  readonly profile: string;
  readonly runtime: Pick<
    Runtime,
    'coding' | 'codingChanges' | 'conversations' | 'conversationStore'
  >;
  readonly owner: RuntimeOwnerDecisions;
  constructor(
    profile: string,
    runtime: Pick<Runtime, 'coding' | 'codingChanges' | 'conversations' | 'conversationStore'>,
    owner: RuntimeOwnerDecisions,
  ) {
    this.profile = profile;
    this.runtime = runtime;
    this.owner = owner;
    this.#reserve = new ProjectReservation(profile, runtime, owner);
    this.#prepare = new ProjectPreparation(runtime, owner);
  }
  async dispatch(
    params: Record<string, unknown>,
    draining = false,
    operation: 'reserve' | 'prepare' = 'reserve',
  ): Promise<RuntimeReply> {
    try {
      if (draining || this.#closing.signal.aborted) throw Error('runtime_draining');
      const reserve =
        operation === 'reserve' && isCodingTaskReserve(params) ? normalize(params) : null;
      const prepare =
        operation === 'prepare' && isCodingTaskPrepare(params) ? normalizePrepare(params) : null;
      if (!reserve && !prepare) throw Error('invalid_params');
      const ref = reserve ? reference(reserve) : prepareReference(prepare!),
        binding = ownerPreview(reserve ?? prepare);
      const existing = () =>
        reserve
          ? this.#reserve.existing(reserve, (id) => this.#jobs.has(id))
          : this.#prepare.existing(prepare!, (id) => this.#jobs.has(id));
      const previous = await existing();
      if (previous) return { result: previous };
      if (this.#closing.signal.aborted) throw Error('runtime_draining');
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
        opened = true;
        const wait = this.owner.open(
          card,
          preview,
          this.#closing.signal,
          async () =>
            !this.#closing.signal.aborted && (await current()) && !this.#closing.signal.aborted,
        );
        acknowledge({
          result: reserve
            ? { status: 'pending', decision: card, task: null }
            : { status: 'pending', decision: card, worktree: null },
        });
        return (await wait) === 'allowed' && !this.#closing.signal.aborted;
      };
      const done = Promise.resolve()
        .then(async () => {
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
            : await this.runtime.codingChanges.prepare(this.#prepare.access(prepare!), {
                confirm: (authorized) =>
                  confirm(preparePreview(prepare!, authorized), () =>
                    this.#prepare.current(prepare!, authorized),
                  ),
              });
          if (!result.ok) acknowledge({ error: { code: result.error.code } });
          else {
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
    return this.#failure ? 'uncertain' : 'settled';
  }
}
