/**
 * Internal backend the public transport delegates to.
 *
 * Plain TypeScript only: the public `ExecutorServicePluginTransport`
 * declaration must not pull Effect/SDK types into its graph. The Effect-bearing
 * implementation lives in `admission.ts`; this interface is the seam between
 * them.
 */
import type {
  ServicePluginCatalog,
  ServicePluginDiscoveryOptions,
  ServicePluginInvokeOptions,
  ServicePluginInvokeOutcome,
  ServicePluginInvocation,
  ServicePluginTarget,
} from '@runnets/application';

export interface ExecutorTransportBackend {
  discover(
    target: ServicePluginTarget,
    options: ServicePluginDiscoveryOptions,
  ): Promise<ServicePluginCatalog>;
  invoke(
    target: ServicePluginTarget,
    invocation: ServicePluginInvocation,
    options: ServicePluginInvokeOptions,
  ): Promise<ServicePluginInvokeOutcome>;
  close(): Promise<void>;
}
