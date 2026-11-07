import {
  validServiceConnectionRequest,
  validServiceReceiptQuery,
  validServiceConnectionSetRequest,
  type ServiceConnectionRequest,
  type ServiceConnectionSetRequest,
} from './service-owner-requests.js';
import {
  authorityObject as object,
  authorityKeys as keys,
} from './service-authority-validation.js';
export interface ServiceOwnerOperationsQuery {
  readonly after?: string;
  readonly limit?: number;
  readonly state?: 'prepared' | 'completed';
}
/** Keyless historical intent is data for explicit recovery, never execution authority. */
export type ServiceOwnerOperation =
  | {
      readonly method: 'service.connection-set';
      readonly input: Omit<ServiceConnectionSetRequest, 'key'>;
      readonly requiresKey: boolean;
    }
  | {
      readonly method: 'service.connection-refresh';
      readonly input: ServiceConnectionRequest;
      readonly requiresKey: false;
    };
export function validServiceOwnerOperationsQuery(v: unknown): v is ServiceOwnerOperationsQuery {
  return (
    object(v) &&
    Object.keys(v).every((k) => ['after', 'limit', 'state'].includes(k)) &&
    (!Object.hasOwn(v, 'after') || validServiceReceiptQuery({ requestId: v['after'] })) &&
    (!Object.hasOwn(v, 'limit') ||
      (Number.isSafeInteger(v['limit']) && Number(v['limit']) >= 1 && Number(v['limit']) <= 100)) &&
    (!Object.hasOwn(v, 'state') || v['state'] === 'prepared' || v['state'] === 'completed')
  );
}
export function validServiceOwnerOperation(v: unknown): v is ServiceOwnerOperation {
  if (!object(v) || !keys(v, ['method', 'input', 'requiresKey']) || !object(v['input']))
    return false;
  if (v['method'] === 'service.connection-refresh')
    return v['requiresKey'] === false && validServiceConnectionRequest(v['input']);
  return (
    v['method'] === 'service.connection-set' &&
    typeof v['requiresKey'] === 'boolean' &&
    !Object.hasOwn(v['input'], 'key') &&
    validServiceConnectionSetRequest(v['input']) &&
    (!v['requiresKey'] ||
      (v['input']['configuration'].kind === 'http' && v['input']['removeKey'] !== true))
  );
}
