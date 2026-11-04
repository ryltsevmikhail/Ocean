import type {
  ModelConnectionService,
  ModelConnectionMetadataService,
  BotModelBindingService,
  BotModelBindingReads,
  RoomModelPolicyService,
  RoomModelExecutionReads,
} from '@runnets/application';
import {
  isLocalModelConnectionsQuery,
  isLocalModelConnectionSetRequest,
  isLocalModelConnectionQuery,
  isLocalModelConnectionRevisionRequest,
  isLocalCreateBoundBotRequest,
  isLocalSetBotModelBindingRequest,
  isLocalBoundBotsQuery,
  isLocalModelRunQuery,
  isLocalRoomModelPolicyQuery,
  isLocalSetRoomModelPolicyRequest,
} from '@runnets/contracts';
import type { RuntimeReply } from './queries.js';
export interface ModelSettingsServices {
  readonly connections: Pick<
    ModelConnectionService,
    'set' | 'check' | 'disconnect' | 'removeSavedKey'
  >;
  readonly metadata: Pick<ModelConnectionMetadataService, 'list'>;
  readonly bindings: Pick<BotModelBindingService, 'create' | 'set'>;
  readonly bots: Pick<BotModelBindingReads, 'list'>;
  readonly policy: Pick<RoomModelPolicyService, 'get' | 'set'>;
  readonly execution: Pick<RoomModelExecutionReads, 'get'>;
}
/** Only declared application failures are public; arbitrary thrown messages never cross IPC. */
const errors = new Set(
  `invalid_params invalid_input projection_too_large workspace_conflict unknown_room
  unknown_run unknown_bot unknown_connection connection_not_found provider_write_failed unknown_model handle_taken bot_profile_version_conflict
  model_policy_unavailable model_policy_revision_conflict model_policy_members_conflict model_policy_work_conflict
  model_transfer_denied model_execution_unavailable connection_unverified provider_unverified provider_unavailable
  provider_injected provider_secret_corrupt provider_secret_insecure insecure_permissions provider_restored provider_invalid_model provider_disconnected restore_restricted
  revision_conflict request_conflict receipt_result_unavailable outcome_unknown`.split(/\s+/),
);
function failure(error: unknown): RuntimeReply {
  return {
    error: {
      code: error instanceof Error && errors.has(error.message) ? error.message : 'runtime_failure',
    },
  };
}
function conversation<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw Error(result.error.code);
  return result.value;
}
/** Owner jobs outlive sockets. Drain closes admission before waiting, including async journal reads. */
export class ModelSettings {
  readonly #services: ModelSettingsServices;
  readonly #mutationsAllowed: boolean;
  readonly #jobs = new Set<Promise<RuntimeReply>>();
  #draining = false;
  constructor(services: ModelSettingsServices, mutationsAllowed: boolean) {
    this.#services = services;
    this.#mutationsAllowed = mutationsAllowed;
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    const s = this.#services;
    try {
      switch (method) {
        case 'modelConnections.list':
          if (isLocalModelConnectionsQuery(params)) return { result: s.metadata.list(params) };
          break;
        case 'bots.listBound':
          if (isLocalBoundBotsQuery(params)) return { result: s.bots.list(params) };
          break;
        case 'rooms.getModelPolicy':
          if (isLocalRoomModelPolicyQuery(params))
            return { result: conversation(s.policy.get(params)) };
          break;
        case 'runs.modelExecution':
          if (isLocalModelRunQuery(params))
            return this.#supervise(() => s.execution.get(params), false);
          break;
        case 'modelConnections.set':
          if (isLocalModelConnectionSetRequest(params))
            return this.#supervise(() => s.connections.set(params));
          break;
        case 'modelConnections.check':
          if (isLocalModelConnectionQuery(params))
            return this.#supervise(() => s.connections.check(params.connectionId, detached));
          break;
        case 'modelConnections.disconnect':
        case 'modelConnections.removeSavedKey':
          if (isLocalModelConnectionRevisionRequest(params))
            return this.#supervise(() =>
              method === 'modelConnections.disconnect'
                ? s.connections.disconnect(params)
                : s.connections.removeSavedKey(params),
            );
          break;
        case 'bots.createBound':
          if (isLocalCreateBoundBotRequest(params))
            return this.#supervise(() => conversation(s.bindings.create(params)));
          break;
        case 'bots.setModelBinding':
          if (isLocalSetBotModelBindingRequest(params))
            return this.#supervise(() => conversation(s.bindings.set(params)));
          break;
        case 'rooms.setModelPolicy':
          if (isLocalSetRoomModelPolicyRequest(params))
            return this.#supervise(() => conversation(s.policy.set(params)));
          break;
      }
      return { error: { code: 'invalid_params' } };
    } catch (error) {
      return failure(error);
    }
  }
  #supervise(run: () => unknown, mutation = true): Promise<RuntimeReply> {
    if (this.#draining) return Promise.resolve({ error: { code: 'runtime_draining' } });
    if (mutation && !this.#mutationsAllowed)
      return Promise.resolve({ error: { code: 'restore_restricted' } });
    const job = this.#run(run);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
    return job;
  }
  async #run(run: () => unknown): Promise<RuntimeReply> {
    try {
      return { result: await run() };
    } catch (error) {
      return failure(error);
    }
  }
  async drain(): Promise<'settled'> {
    this.#draining = true;
    await Promise.all(this.#jobs);
    return 'settled';
  }
}
