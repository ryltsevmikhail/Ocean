/** Explicit owner-only neutral service protocol. Feature support confers no account authority. */
export const LOCAL_SERVICE_AUTHORITY = 'service.authority-v2';
export const LOCAL_SERVICE_READ_METHODS = [
  'service.connections',
  'service.grants',
  'service.receipt',
] as const;
export const LOCAL_SERVICE_METHODS = [
  ...LOCAL_SERVICE_READ_METHODS,
  'service.connection-set',
  'service.connection-disconnect',
  'service.connection-refresh',
  'service.grant-set',
  'service.grant-revoke',
] as const;
export {
  validServiceOwnerQuery as isLocalServiceQuery,
  validServiceReceiptQuery as isLocalServiceReceiptQuery,
  validServiceConnectionRequest as isLocalServiceConnectionRequest,
  validServiceConnectionSetRequest as isLocalServiceConnectionSetRequest,
  validServiceGrantSetRequest as isLocalServiceGrantSetRequest,
  validServiceGrantRevokeRequest as isLocalServiceGrantRevokeRequest,
  type ServiceConnectionRequest as LocalServiceConnectionRequest,
  type ServiceConnectionSetRequest as LocalServiceConnectionSetRequest,
  type ServiceGrantSetRequest as LocalServiceGrantSetRequest,
  type ServiceGrantRevokeRequest as LocalServiceGrantRevokeRequest,
} from '@runnets/domain';
