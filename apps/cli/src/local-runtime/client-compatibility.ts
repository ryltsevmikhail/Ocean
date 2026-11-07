import {
  LOCAL_MODEL_CONNECTIONS,
  LOCAL_ROOM_TASKS,
  LOCAL_ROOM_TASK_LIST,
  LOCAL_CODING_WORKSPACE,
  LOCAL_SERVICE_CONFIRMATIONS,
  LOCAL_PLUGIN_SESSION_AUTHORITY,
  LOCAL_ADDRESSED_HISTORY,
  type LocalRuntimeIdentity,
} from '@runnets/contracts';

/** Hello features describe wire support only; they never grant bot or tool authority. */
export function clientFeatures(params: Record<string, unknown>): readonly string[] | null {
  if (!('clientFeatures' in params)) return [];
  const features = params['clientFeatures'];
  return Array.isArray(features) &&
    features.length <= 16 &&
    features.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 64)
    ? features
    : null;
}

/** RC2 accepts at most 64 capabilities and cannot use the session-authority plugin API. */
export interface RuntimeWireContext {
  readonly models: boolean;
  readonly serviceConfirmations?: boolean;
  readonly addressedHistory?: boolean;
  readonly roomTasks?: boolean;
  readonly roomTaskList?: boolean;
  readonly codingWorkspace?: boolean;
}
export const LEGACY_WIRE_CONTEXT: RuntimeWireContext = Object.freeze({ models: false });
export function clientIdentity<T extends LocalRuntimeIdentity>(
  identity: T,
  plugins: boolean,
  models = false,
  services = false,
  serviceConfirmations = false,
  addressedHistory = false,
  roomTasks = false,
  roomTaskList = false,
  codingWorkspace = false,
): T {
  return {
    ...identity,
    capabilities: identity.capabilities.filter(
      (c) =>
        (serviceConfirmations || c !== LOCAL_SERVICE_CONFIRMATIONS) &&
        (addressedHistory || c !== LOCAL_ADDRESSED_HISTORY) &&
        ((roomTasks && addressedHistory) || c !== LOCAL_ROOM_TASKS) &&
        ((roomTaskList && roomTasks && addressedHistory) || c !== LOCAL_ROOM_TASK_LIST) &&
        (codingWorkspace || c !== LOCAL_CODING_WORKSPACE) &&
        (plugins || !c.startsWith('plugin.')) &&
        (models || c !== LOCAL_MODEL_CONNECTIONS) &&
        (services || !c.startsWith('service.')),
    ),
  };
}
export function supportsPlugins(features: readonly string[]): boolean {
  return features.includes(LOCAL_PLUGIN_SESSION_AUTHORITY);
}
