/**
 * Public entry point: Ocean's qualified, fail-closed Executor transport.
 *
 * Only plain TypeScript types/classes of Ocean's application port are exported
 * here. The pinned Executor SDK and its Effect runtime stay inside this
 * package; nothing below exposes an SDK, Effect or OAuth type.
 */
export { ExecutorServicePluginTransport, ExecutorTransportOpenError } from './transport.js';
export type {
  ExecutorTransportOpenOptions,
  ExecutorTransportQualificationReason,
  ExecutorTransportStatus,
} from './transport.js';
export { PINNED_IDENTITIES } from './pinned-identity.js';
