import type {
  LocalCreateBoundBotRequest,
  LocalSetBotModelBindingRequest,
  LocalBoundBot,
  LocalBoundBotsQuery,
  LocalBoundBotsPage,
  LocalRoomModelPolicy,
  LocalRoomModelPolicyQuery,
  LocalSetRoomModelPolicyRequest,
  LocalRoomModelPolicySnapshot,
} from './local-model-connections.js';
import {
  modelObject as obj,
  modelText as text,
  modelPositive as positive,
  modelEnum as en,
  modelPageQuery,
  modelPage,
} from './local-model-validation.js';
const binding = (v: unknown) =>
  obj(v, ['connectionId', 'modelId']) && text(v['connectionId']) && text(v['modelId']);
const mutation = (v: Record<string, unknown>) =>
  text(v['workspaceId'], 128) && text(v['requestId'], 128);
export const isLocalCreateBoundBotRequest = (v: unknown): v is LocalCreateBoundBotRequest =>
  obj(v, ['workspaceId', 'requestId', 'handle', 'name', 'role', 'binding']) &&
  mutation(v) &&
  typeof v['handle'] === 'string' &&
  /^[a-z][a-z0-9_-]{0,31}$/.test(v['handle']) &&
  text(v['name']) &&
  text(v['role'], 8192) &&
  binding(v['binding']);
export const isLocalSetBotModelBindingRequest = (v: unknown): v is LocalSetBotModelBindingRequest =>
  obj(v, ['workspaceId', 'requestId', 'botId', 'expectedProfileVersion', 'binding']) &&
  mutation(v) &&
  text(v['botId'], 128) &&
  positive(v['expectedProfileVersion']) &&
  v['expectedProfileVersion'] < Number.MAX_SAFE_INTEGER &&
  binding(v['binding']);
export const isLocalBoundBot = (v: unknown): v is LocalBoundBot =>
  obj(v, ['bot', 'binding']) &&
  (v['binding'] === null || binding(v['binding'])) &&
  obj(v['bot'], [
    'id',
    'workspaceId',
    'handle',
    'name',
    'role',
    'provider',
    'model',
    'profileVersion',
  ]) &&
  text(v['bot']['id'], 128) &&
  text(v['bot']['workspaceId'], 128) &&
  typeof v['bot']['handle'] === 'string' &&
  /^[a-z][a-z0-9_-]{0,31}$/.test(v['bot']['handle']) &&
  text(v['bot']['name']) &&
  text(v['bot']['role'], 8192) &&
  text(v['bot']['provider'], 128) &&
  text(v['bot']['model']) &&
  positive(v['bot']['profileVersion']);
export const isLocalBoundBotsQuery = (v: unknown): v is LocalBoundBotsQuery =>
  modelPageQuery(v, ['workspaceId'], ['roomId'], 128) &&
  obj(v, ['workspaceId'], ['roomId', 'after', 'limit']) &&
  text(v['workspaceId'], 128) &&
  (v['roomId'] === undefined || text(v['roomId'], 128));
export const isLocalBoundBotsPage = (v: unknown): v is LocalBoundBotsPage =>
  modelPage(v, ['workspaceId', 'roomId'], isLocalBoundBot, 128) &&
  text(v['workspaceId'], 128) &&
  (v['roomId'] === null || text(v['roomId'], 128)) &&
  v.items.every((x) => isLocalBoundBot(x) && x.bot.workspaceId === v['workspaceId']);
export const isLocalRoomModelPolicyQuery = (v: unknown): v is LocalRoomModelPolicyQuery =>
  obj(v, ['workspaceId', 'roomId']) && text(v['workspaceId'], 128) && text(v['roomId'], 128);
export const isLocalSetRoomModelPolicyRequest = (v: unknown): v is LocalSetRoomModelPolicyRequest =>
  obj(v, ['workspaceId', 'roomId', 'requestId', 'expectedRevision', 'cloudTransfer']) &&
  mutation(v) &&
  text(v['roomId'], 128) &&
  positive(v['expectedRevision']) &&
  v['expectedRevision'] < Number.MAX_SAFE_INTEGER &&
  en(v['cloudTransfer'], ['allow', 'deny']);
export const isLocalRoomModelPolicy = (v: unknown): v is LocalRoomModelPolicy =>
  obj(v, ['roomId', 'revision', 'cloudTransfer']) &&
  text(v['roomId'], 128) &&
  positive(v['revision']) &&
  en(v['cloudTransfer'], ['allow', 'deny']);
export const isLocalRoomModelPolicySnapshot = (v: unknown): v is LocalRoomModelPolicySnapshot =>
  obj(v, ['version', 'workspaceId', 'roomId', 'policy']) &&
  v['version'] === 1 &&
  text(v['workspaceId'], 128) &&
  text(v['roomId'], 128) &&
  isLocalRoomModelPolicy(v['policy']) &&
  v['policy'].roomId === v['roomId'];
