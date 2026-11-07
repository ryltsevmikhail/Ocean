import type { ServiceConnection } from '@runnets/domain';
import type { ServiceResourceEvidence } from './service-resource-evidence.js';
import type {
  ServiceCallAdmissionOptions,
  ServiceCallRequest,
  ServiceCallResult,
} from './service-admission-types.js';
import type { ServicePluginInvokeOutcome } from './service-plugin-transport.js';
export async function closeServiceResource(
  resource: ServiceResourceEvidence | undefined,
  errors: unknown[],
): Promise<void> {
  try {
    await resource?.close();
  } catch (error) {
    errors.push(error);
  }
}
export function serviceCleanupResult(
  result: ServiceCallResult,
  errors: readonly unknown[],
): ServiceCallResult {
  return errors.length
    ? {
        ...result,
        cleanupError: new AggregateError(errors, 'Service cleanup or recording unconfirmed'),
      }
    : result;
}
/** Fence synchronously, unwind all proof work, preserve durable outcome, then join retirement even on error. */
export async function finishServiceCall(
  options: ServiceCallAdmissionOptions,
  request: ServiceCallRequest,
  connection: ServiceConnection,
  generation: unknown,
  outcome: ServicePluginInvokeOutcome,
  resource: ServiceResourceEvidence | undefined,
  errors: unknown[],
  preparation?: Promise<void>,
): Promise<ServiceCallResult> {
  let retirement: Promise<void> | undefined;
  if (outcome.kind === 'uncertain') {
    try {
      retirement = options.transport.retireUncertain?.(
        connection,
        typeof generation === 'string' ? generation : undefined,
      );
      void retirement?.catch(() => {});
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await preparation;
  } catch (error) {
    if (error instanceof AggregateError) errors.push(error);
  }
  await closeServiceResource(resource, errors);
  try {
    const settlement =
      outcome.kind === 'observed' ? (outcome.code === 'ok' ? 'completed' : 'failed') : outcome.kind;
    options.store.atomic((tx) => tx.settle(request, settlement));
  } catch (error) {
    errors.push(error);
  }
  try {
    await retirement;
  } catch (error) {
    errors.push(error);
  }
  return serviceCleanupResult({ code: outcome.code, outcome }, errors);
}
