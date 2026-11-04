import {
  LOCAL_MODEL_CONNECTIONS,
  isLocalModelConnectionsQuery,
  isLocalModelConnectionsPage,
  isLocalModelConnectionSetRequest,
  isLocalModelConnectionRevisionRequest,
  isLocalModelConnectionQuery,
  isLocalModelConnectionStatus,
  isLocalModelConnectionCheckResponse,
  isLocalCreateBoundBotRequest,
  isLocalSetBotModelBindingRequest,
  isLocalBoundBot,
  isLocalBoundBotsQuery,
  isLocalBoundBotsPage,
  isLocalModelRunQuery,
  isLocalRunModelExecution,
  isLocalRoomModelPolicyQuery,
  isLocalRoomModelPolicySnapshot,
  isLocalSetRoomModelPolicyRequest,
  isLocalRoomModelPolicy,
  type LocalRuntimeIdentity,
  type LocalModelConnectionsQuery,
  type LocalModelConnectionsPage,
  type LocalModelConnectionSetRequest,
  type LocalModelConnectionRevisionRequest,
  type LocalModelConnectionQuery,
  type LocalModelConnectionStatus,
  type LocalModelConnectionCheckResponse,
  type LocalCreateBoundBotRequest,
  type LocalSetBotModelBindingRequest,
  type LocalBoundBot,
  type LocalBoundBotsQuery,
  type LocalBoundBotsPage,
  type LocalRunQuery,
  type LocalRunModelExecution,
  type LocalRoomModelPolicyQuery,
  type LocalRoomModelPolicySnapshot,
  type LocalSetRoomModelPolicyRequest,
  type LocalRoomModelPolicy,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
type Send = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
export interface LocalModelConnectionsClient {
  listModelConnections(input?: LocalModelConnectionsQuery): Promise<LocalModelConnectionsPage>;
  setModelConnection(input: LocalModelConnectionSetRequest): Promise<LocalModelConnectionStatus>;
  checkModelConnection(
    input: LocalModelConnectionQuery,
  ): Promise<LocalModelConnectionCheckResponse>;
  disconnectModelConnection(
    input: LocalModelConnectionRevisionRequest,
  ): Promise<LocalModelConnectionStatus>;
  removeModelConnectionKey(
    input: LocalModelConnectionRevisionRequest,
  ): Promise<LocalModelConnectionStatus>;
  createBoundBot(input: LocalCreateBoundBotRequest): Promise<LocalBoundBot>;
  setBotModelBinding(input: LocalSetBotModelBindingRequest): Promise<LocalBoundBot>;
  listBoundBots(input: LocalBoundBotsQuery): Promise<LocalBoundBotsPage>;
  getRunModelExecution(input: LocalRunQuery): Promise<LocalRunModelExecution>;
  getRoomModelPolicy(input: LocalRoomModelPolicyQuery): Promise<LocalRoomModelPolicySnapshot>;
  setRoomModelPolicy(input: LocalSetRoomModelPolicyRequest): Promise<LocalRoomModelPolicy>;
}
/** All wrappers refuse unsupported hosts before validation or send; feature support grants no authority. */
export function localModelConnectionsClient(
  send: Send,
  identity: Pick<LocalRuntimeIdentity, 'capabilities'>,
): LocalModelConnectionsClient {
  const supported = identity.capabilities.includes(LOCAL_MODEL_CONNECTIONS);
  async function call<Q, R>(
    method: string,
    input: Q,
    request: (v: unknown) => v is Q,
    response: (v: unknown) => v is R,
    matches: (v: R, q: Q) => boolean = () => true,
    timeout?: number,
  ): Promise<R> {
    if (!supported) throw Error('model_runtime_upgrade_required');
    const q = structuredClone(validatedParams(input, request));
    const r = timeout === undefined ? await send(method, q) : await send(method, q, timeout);
    if (!response(r) || !matches(r, q)) throw Error('invalid_frame');
    return r;
  }
  const statusMatches = (
    r: LocalModelConnectionStatus,
    q: LocalModelConnectionRevisionRequest | LocalModelConnectionSetRequest,
  ) => r.connectionId === q.connectionId && r.revision === (q.expectedRevision ?? 0) + 1;
  return {
    listModelConnections: (q = {}) =>
      call(
        'modelConnections.list',
        q,
        isLocalModelConnectionsQuery,
        isLocalModelConnectionsPage,
        (r, q) =>
          r.workspaceId === (q.workspaceId ?? null) &&
          pageMatches(r.items, r.nextAfter, q, (x) => x.connectionId),
      ),
    setModelConnection: (q) =>
      call(
        'modelConnections.set',
        q,
        isLocalModelConnectionSetRequest,
        isLocalModelConnectionStatus,
        (r, q) =>
          statusMatches(r, q) &&
          r.providerId === q.providerId &&
          r.kind === q.kind &&
          r.endpoint === q.endpoint &&
          r.auth === q.auth &&
          r.defaultModelId === q.defaultModelId,
      ),
    checkModelConnection: (q) =>
      call(
        'modelConnections.check',
        q,
        isLocalModelConnectionQuery,
        isLocalModelConnectionCheckResponse,
        (r, q) =>
          r.status.connectionId === q.connectionId && r.check.connectionId === q.connectionId,
        12_000,
      ),
    disconnectModelConnection: (q) =>
      call(
        'modelConnections.disconnect',
        q,
        isLocalModelConnectionRevisionRequest,
        isLocalModelConnectionStatus,
        statusMatches,
      ),
    removeModelConnectionKey: (q) =>
      call(
        'modelConnections.removeSavedKey',
        q,
        isLocalModelConnectionRevisionRequest,
        isLocalModelConnectionStatus,
        statusMatches,
      ),
    createBoundBot: (q) =>
      call(
        'bots.createBound',
        q,
        isLocalCreateBoundBotRequest,
        isLocalBoundBot,
        (r, q) =>
          r.bot.workspaceId === q.workspaceId &&
          r.bot.handle === q.handle &&
          r.bot.name === q.name &&
          r.bot.role === q.role &&
          r.bot.profileVersion === 1 &&
          sameBinding(r, q.binding),
      ),
    setBotModelBinding: (q) =>
      call(
        'bots.setModelBinding',
        q,
        isLocalSetBotModelBindingRequest,
        isLocalBoundBot,
        (r, q) =>
          r.bot.workspaceId === q.workspaceId &&
          r.bot.id === q.botId &&
          r.bot.profileVersion === q.expectedProfileVersion + 1 &&
          sameBinding(r, q.binding),
      ),
    listBoundBots: (q) =>
      call(
        'bots.listBound',
        q,
        isLocalBoundBotsQuery,
        isLocalBoundBotsPage,
        (r, q) =>
          r.workspaceId === q.workspaceId &&
          r.roomId === (q.roomId ?? null) &&
          pageMatches(r.items, r.nextAfter, q, (x) => x.bot.id),
      ),
    getRunModelExecution: (q) =>
      call(
        'runs.modelExecution',
        q,
        isLocalModelRunQuery,
        isLocalRunModelExecution,
        (r, q) => r.workspaceId === q.workspaceId && r.roomId === q.roomId && r.runId === q.runId,
      ),
    getRoomModelPolicy: (q) =>
      call(
        'rooms.getModelPolicy',
        q,
        isLocalRoomModelPolicyQuery,
        isLocalRoomModelPolicySnapshot,
        (r, q) => r.workspaceId === q.workspaceId && r.roomId === q.roomId,
      ),
    setRoomModelPolicy: (q) =>
      call(
        'rooms.setModelPolicy',
        q,
        isLocalSetRoomModelPolicyRequest,
        isLocalRoomModelPolicy,
        (r, q) =>
          r.roomId === q.roomId &&
          r.revision === q.expectedRevision + 1 &&
          r.cloudTransfer === q.cloudTransfer,
      ),
  };
}
function sameBinding(r: LocalBoundBot, b: { connectionId: string; modelId: string }) {
  return (
    r.binding?.connectionId === b.connectionId &&
    r.binding.modelId === b.modelId &&
    r.bot.model === b.modelId
  );
}
function pageMatches<T>(
  items: readonly T[],
  next: string | null,
  q: { after?: string; limit?: number },
  id: (item: T) => string,
) {
  let previous = q.after ?? '';
  if (items.length > (q.limit ?? 50)) return false;
  for (const item of items) {
    const current = id(item);
    if (current <= previous) return false;
    previous = current;
  }
  return next === null || (items.length > 0 && next === previous);
}
