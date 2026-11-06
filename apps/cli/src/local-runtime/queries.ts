import { LEGACY_WIRE_CONTEXT, type RuntimeWireContext } from './client-compatibility.js';
import type { RoomRuntimeRuns } from '@runnets/application';
import type { ConversationMessage } from '@runnets/domain';
import {
  LOCAL_RUNTIME_MAX_FRAME,
  isLocalRoomsQuery,
  isLocalRoomListQuery,
  isLocalRunQuery,
  isLocalHistoryQuery,
  isLocalEventsQuery,
  isLocalObserveQuery,
  isLocalRoomObserveQuery,
  isLocalCancelRequest,
} from '@runnets/contracts';
import { RuntimeObservers } from './observe.js';

export type RuntimeReply = { result: unknown } | { error: { code: string } };
function wireMessage({ body, ...m }: ConversationMessage) {
  return { ...m, bodyBase64: Buffer.from(body, 'utf8').toString('base64') };
}
/** Leave room for the maximum escaped request ID and response envelope. Stop before advancing past an omitted item. */
export function wirePage<T>(rows: Iterable<T>) {
  let budget = LOCAL_RUNTIME_MAX_FRAME - 1024;
  const results: T[] = [];
  for (const row of rows) {
    budget -= Buffer.byteLength(JSON.stringify(row)) + 1;
    if (budget < 0) {
      if (!results.length) throw Error('query_limit');
      break;
    }
    results.push(row);
  }
  return results;
}
function* messages(rows: Iterable<ConversationMessage>) {
  for (const row of rows) yield wireMessage(row);
}
const knownErrors = new Set([
  'observer_busy',
  'unknown_run',
  'unknown_workspace',
  'unknown_room',
  'resync_required',
  'query_limit',
  'run_not_active',
  'run_not_started',
  'version_conflict',
  'request_conflict',
  'terminal_state',
  'invalid_transition',
  'observation_closed',
  'client_upgrade_required',
]);
export class RuntimeQueries {
  readonly #service: RoomRuntimeRuns;
  readonly #observers: RuntimeObservers;
  constructor(service: RoomRuntimeRuns, instance: string) {
    this.#service = service;
    this.#observers = new RuntimeObservers(service.reads, instance);
  }
  get observers(): RuntimeObservers {
    return this.#observers;
  }
  close() {
    this.#observers.close();
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
    controller?: AbortController,
    context: RuntimeWireContext = LEGACY_WIRE_CONTEXT,
  ): RuntimeReply | Promise<RuntimeReply> {
    const reads = this.#service.reads;
    try {
      switch (method) {
        case 'rooms.list':
          if (isLocalRoomsQuery(params))
            return {
              result: reads.rooms(params.workspaceId, params.after ?? '', params.limit ?? 50),
            };
          break;
        case 'rooms.members':
          if (isLocalRoomListQuery(params))
            return { result: reads.members(params, params.after ?? '', params.limit ?? 50) };
          break;
        case 'history.list':
          if (isLocalHistoryQuery(params)) {
            const rows = Array.from(reads.history(params, params.after ?? 0, params.limit ?? 50));
            if (
              !context.addressedHistory &&
              rows.some((m) => m.author === 'bot' && m.authorBotId !== m.targetBotId)
            )
              throw Error('client_upgrade_required');
            return { result: wirePage(messages(rows)) };
          }
          break;
        case 'runs.list':
          if (isLocalRoomListQuery(params))
            return { result: wirePage(reads.runs(params, params.after ?? '', params.limit ?? 50)) };
          break;
        case 'runs.get':
          if (isLocalRunQuery(params)) return { result: reads.run(params) };
          break;
        case 'runs.result':
          if (isLocalRunQuery(params)) {
            const m = reads.result(params);
            return {
              result: {
                workspaceId: params.workspaceId,
                roomId: params.roomId,
                runId: params.runId,
                message: m ? wireMessage(m) : null,
              },
            };
          }
          break;
        case 'runs.events':
          if (isLocalEventsQuery(params))
            return {
              result: {
                workspaceId: params.workspaceId,
                roomId: params.roomId,
                runId: params.runId,
                events: reads.events(params, params.after ?? 0, params.limit ?? 50).map((event) =>
                  !context.models &&
                  (event.type === 'attempt.model_request_started' ||
                    event.type === 'attempt.model_request_settled')
                    ? {
                        sequence: event.sequence,
                        type: 'redacted' as const,
                        sensitivity: 'restricted' as const,
                      }
                    : event,
                ),
              },
            };
          break;
        case 'observe':
          if (isLocalObserveQuery(params) || isLocalRoomObserveQuery(params))
            return this.#observers
              .observe(params, detached)
              .then((result) => ({ result }), queryError);
          break;
        case 'runs.cancel':
          if (isLocalCancelRequest(params))
            return this.#service
              .cancel(params, controller)
              .then((result) => ({ result }), queryError);
          break;
        default:
          return { error: { code: 'method_not_found' } };
      }
      return { error: { code: 'invalid_params' } };
    } catch (e) {
      return queryError(e);
    }
  }
}

function queryError(e: unknown): RuntimeReply {
  return {
    error: {
      code: e instanceof Error && knownErrors.has(e.message) ? e.message : 'runtime_failure',
    },
  };
}
