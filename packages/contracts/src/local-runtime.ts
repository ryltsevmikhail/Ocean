/** Independent local-runtime v1 wire contract; deliberately separate from ACP. */
export const LOCAL_RUNTIME_PROTOCOL = 1 as const;
export const LOCAL_RUNTIME_MAX_FRAME = 2 * 1024 * 1024;
export const LOCAL_RUNTIME_MAX_PAGE = 200;
export const LOCAL_RUNTIME_MAX_WAIT_MS = 30_000;
export interface LocalRuntimeIdentity {
  readonly protocol: 1;
  readonly profileId: string;
  readonly instanceId: string;
  readonly capabilities: readonly ['status', 'stop'];
}
export interface LocalRuntimeDescriptor {
  readonly protocol: 1;
  readonly profileId: string;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly capability: string;
}
export interface LocalRuntimeStatus extends LocalRuntimeIdentity {
  readonly state: 'ready' | 'draining' | 'stop_incomplete';
}
export interface LocalRuntimeStop {
  readonly instanceId: string;
  readonly state: 'stopped' | 'stop_incomplete';
  readonly outcome: 'complete' | 'uncertain';
}
export interface LocalRuntimeRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}
export type LocalRuntimeResponse =
  | { readonly id: string; readonly result: unknown }
  | { readonly id: string; readonly error: { readonly code: string } };
export function localRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isLocalRuntimeRequest(value: unknown): value is LocalRuntimeRequest {
  return (
    localRuntimeRecord(value) &&
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    value['id'].length <= 128 &&
    typeof value['method'] === 'string' &&
    value['method'].length <= 64 &&
    localRuntimeRecord(value['params'])
  );
}
export function isLocalRuntimeIdentity(value: unknown): value is LocalRuntimeIdentity {
  return (
    localRuntimeRecord(value) &&
    value['protocol'] === 1 &&
    typeof value['profileId'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['profileId']) &&
    typeof value['instanceId'] === 'string' &&
    /^[a-f0-9-]{36}$/.test(value['instanceId']) &&
    Array.isArray(value['capabilities']) &&
    value['capabilities'].length === 2 &&
    value['capabilities'][0] === 'status' &&
    value['capabilities'][1] === 'stop'
  );
}
