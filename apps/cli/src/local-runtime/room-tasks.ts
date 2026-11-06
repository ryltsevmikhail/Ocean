import { canonicalJson } from '@runnets/domain';
import {
  claimRoomDelivery,
  ChatPreparationRefusal,
  recoverUnstartedRoomClaims,
  executeChatTurn,
  stopRoomTask,
  releaseUnstartedRoomClaim,
  type RoomTaskPersistence,
  type RoomDeliveryClaimDeps,
  type ChatTurnExecutionDeps,
  type RoomRunReadPort,
} from '@runnets/application';
import {
  isRoomTaskStart,
  isRoomTaskGet,
  isRoomTaskStop,
  isRoomTaskObserve,
  type RoomTaskScope,
  type RoomTaskRootView,
} from '@runnets/contracts';
import { RuntimeObservers } from './observe.js';
import { LEGACY_WIRE_CONTEXT, type RuntimeWireContext } from './client-compatibility.js';
import type { RuntimeReply } from './queries.js';
export class RuntimeRoomTasks {
  readonly #service: RoomTaskPersistence;
  readonly #deps: RoomDeliveryClaimDeps;
  readonly #execution: ChatTurnExecutionDeps;
  readonly #observers: RuntimeObservers;
  readonly #ownsObservers: boolean;
  readonly #jobs = new Map<
    string,
    {
      rootId: string;
      turnId: string;
      controller: AbortController;
      settled: Promise<void>;
      held?: boolean;
    }
  >();
  readonly #capacity: number;
  #slots = 0;
  #queued = false;
  #draining = false;
  #uncertain = false;
  #lastRoot: string | null = null;
  constructor(
    service: RoomTaskPersistence,
    deps: RoomDeliveryClaimDeps,
    execution: ChatTurnExecutionDeps,
    reads: RoomRunReadPort,
    instance: string,
    capacity = 2,
    observers?: RuntimeObservers,
  ) {
    if (capacity !== 1 && capacity !== 2) throw Error('invalid_input');
    this.#service = service;
    this.#deps = { ...deps, onCommitted: () => this.wake() };
    this.#execution = execution;
    this.#observers = observers ?? new RuntimeObservers(reads, instance);
    this.#ownsObservers = observers === undefined;
    this.#capacity = capacity;
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
    context: RuntimeWireContext = LEGACY_WIRE_CONTEXT,
  ): RuntimeReply | Promise<RuntimeReply> {
    if (!context.roomTasks || !context.addressedHistory)
      return { error: { code: 'client_upgrade_required' } };
    try {
      if (method === 'roomTasks.start' && isRoomTaskStart(params)) {
        const replay = this.#deps.store.atomic((tx) => tx.receipt(params.requestId) !== null);
        if (this.#draining && !replay) return { error: { code: 'runtime_draining' } };
        const started = this.#service.startHosted(params);
        if (!started.ok) return { error: { code: started.error.code } };
        if (!replay) this.wake();
        return { result: started.value };
      }
      if (method === 'roomTasks.get' && isRoomTaskGet(params))
        return { result: this.#observers.rootPage(this.#view(params), params.page) };
      if (method === 'roomTasks.observe' && isRoomTaskObserve(params))
        return this.#observers
          .observeRoot(params, () => this.#view(params), detached)
          .then(
            (result) => ({ result }),
            (error: unknown) => ({
              error: {
                code:
                  error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
                    ? error.message
                    : 'runtime_failure',
              },
            }),
          );
      if (method === 'roomTasks.stop' && isRoomTaskStop(params)) {
        const result = stopRoomTask(this.#deps.store, this.#deps.ownerId, params);
        const jobs = [...this.#jobs.values()].filter((j) => j.rootId === params.rootId);
        for (const job of jobs) job.controller.abort();
        return Promise.all(jobs.map((j) => j.settled)).then(async () => {
          const accepted = this.#deps.store.atomic((tx) =>
            tx
              .chatTurns()
              .filter(
                (turn) =>
                  turn.status === 'accepted' &&
                  turn.roomDelivery &&
                  tx.roomTasks?.task(turn.roomDelivery.taskId)?.rootId === params.rootId,
              )
              .map((turn) => turn.id),
          );
          for (const id of accepted)
            await releaseUnstartedRoomClaim({ ...this.#deps, tasks: this.#execution.tasks }, id);
          return { result };
        });
      }
      return { error: { code: 'invalid_params' } };
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
          ? error.message
          : 'runtime_failure';
      return { error: { code } };
    }
  }
  #view(q: RoomTaskScope): RoomTaskRootView {
    return this.#deps.store.atomic((tx) => {
      const root = tx.roomTasks?.task(q.rootId);
      if (
        !root ||
        root.kind !== 'root' ||
        root.workspaceId !== q.workspaceId ||
        root.roomId !== q.roomId ||
        root.rootPayload.ownerId !== this.#deps.ownerId
      )
        throw Error('unknown_root');
      const view = tx.roomTasks!.projection(q.rootId);
      if (!view) throw Error('unknown_root');
      return view;
    });
  }
  start(): void {
    this.wake();
  }
  wake(retryHeld = false): void {
    if (retryHeld) for (const [id, job] of this.#jobs) if (job.held) this.#jobs.delete(id);
    if (this.#queued || this.#draining) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (!this.#draining) this.#pump();
    });
  }
  #pump(): void {
    for (const recovered of recoverUnstartedRoomClaims(this.#deps)) {
      if (this.#slots >= this.#capacity) return;
      if (this.#jobs.has(recovered.turn.taskRunId)) continue;
      this.#slots++;
      this.#launch(recovered);
    }
    let launched = false;
    const roots = this.#deps.store.atomic((tx) =>
      tx
        .roomTasks!.roots()
        .filter(
          (r) =>
            r.status === 'ready' &&
            r.hostScope &&
            canonicalJson(r.hostScope) === canonicalJson(tx.roomTasks!.hostScope()),
        ),
    );
    const split = this.#lastRoot === null ? 0 : roots.findIndex((r) => r.id === this.#lastRoot) + 1;
    for (const root of [...roots.slice(split), ...roots.slice(0, split)]) {
      if (this.#slots >= this.#capacity) return;
      const deliveries = this.#deps.store.atomic((tx) =>
        tx
          .roomTasks!.tasks(root.id)
          .flatMap((t) =>
            t.kind === 'bot' && t.status === 'ready'
              ? tx.roomTasks!.inputs(t.id).filter((d) => d.state === 'queued')
              : [],
          ),
      );
      for (const delivery of deliveries) {
        if (this.#slots >= this.#capacity) return;
        this.#slots++;
        let claimed;
        try {
          claimed = claimRoomDelivery(this.#deps, delivery.id);
        } catch {
          this.#slots--;
          continue;
        }
        if (claimed.kind !== 'claimed') {
          this.#slots--;
          continue;
        }
        launched = true;
        this.#lastRoot = root.id;
        this.#launch(claimed);
        break;
      }
    }
    if (launched && this.#slots < this.#capacity) this.wake();
  }
  #launch(claim: Extract<ReturnType<typeof claimRoomDelivery>, { kind: 'claimed' }>): void {
    const controller = new AbortController();
    const rootId = this.#deps.store.atomic(
      (tx) => tx.roomTasks!.task(claim.turn.roomDelivery!.taskId)!.rootId,
    );
    let held = false;
    const settled = Promise.resolve()
      .then(() =>
        executeChatTurn(
          this.#execution,
          { ...claim, signal: controller.signal, emit() {} },
          { parentRunId: claim.parentRunId, tools: claim.tools },
        ),
      )
      .then(
        (turn) => {
          if (turn.status === 'uncertain') this.#uncertain = true;
        },
        (error: unknown) => {
          held =
            error instanceof ChatPreparationRefusal &&
            recoverUnstartedRoomClaims(this.#deps).some((c) => c.turn.id === claim.turn.id);
          if (!held) this.#uncertain = true;
        },
      )
      .finally(() => {
        if (held) this.#jobs.get(claim.turn.taskRunId)!.held = true;
        else this.#jobs.delete(claim.turn.taskRunId);
        this.#slots--;
        this.wake();
      });
    this.#jobs.set(claim.turn.taskRunId, { rootId, turnId: claim.turn.id, controller, settled });
  }
  controllerFor(runId: string): AbortController | undefined {
    return this.#jobs.get(runId)?.controller;
  }
  async drain(): Promise<'settled' | 'uncertain'> {
    this.#draining = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.all([...this.#jobs.values()].map((j) => j.settled));
    for (const job of this.#jobs.values())
      if (
        job.held &&
        !(await releaseUnstartedRoomClaim(
          { ...this.#deps, tasks: this.#execution.tasks },
          job.turnId,
        ))
      )
        this.#uncertain = true;
    if (this.#ownsObservers) this.#observers.close();
    return this.#uncertain ? 'uncertain' : 'settled';
  }
}
