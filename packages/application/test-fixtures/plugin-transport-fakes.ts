/* eslint-disable no-restricted-imports -- Test-only deterministic transport fake. */
import type {
  ServicePluginCatalog,
  ServicePluginDiscoveryOptions,
  ServicePluginInvocation,
  ServicePluginInvokeOptions,
  ServicePluginInvokeOutcome,
  ServicePluginTarget,
  ServicePluginTool,
  ServicePluginTransportPort,
  ServicePluginTransportQualification,
} from '../src/service-plugin-transport.js';

export interface FakeTransport extends ServicePluginTransportPort {
  discoverCalls: number;
  invokeCalls: number;
  readonly targets: ServicePluginTarget[];
  readonly invocations: ServicePluginInvocation[];
  catalog: (target?: ServicePluginTarget) => Promise<ServicePluginCatalog> | ServicePluginCatalog;
  invocation: () => ServicePluginInvokeOutcome;
}

export function fakePluginTransport(
  catalogResult: (
    target?: ServicePluginTarget,
  ) => Promise<ServicePluginCatalog> | ServicePluginCatalog,
  outcome: () => ServicePluginInvokeOutcome,
): FakeTransport {
  const transport: FakeTransport = {
    discoverCalls: 0,
    invokeCalls: 0,
    targets: [],
    invocations: [],
    catalog: catalogResult,
    invocation: outcome,
    qualification: (): ServicePluginTransportQualification => ({
      qualified: true,
      reason: null,
      identities: { 'plugin-transport': 'fake' },
    }),
    async discover(
      target: ServicePluginTarget,
      _options?: ServicePluginDiscoveryOptions,
    ): Promise<ServicePluginCatalog> {
      transport.discoverCalls++;
      transport.targets.push(target);
      return transport.catalog(target);
    },
    async invoke(
      target: ServicePluginTarget,
      invocation: ServicePluginInvocation,
      _options?: ServicePluginInvokeOptions,
    ): Promise<ServicePluginInvokeOutcome> {
      transport.invokeCalls++;
      transport.targets.push(target);
      transport.invocations.push(invocation);
      return transport.invocation();
    },
  };
  return transport;
}

export function tools(names: readonly string[]): readonly ServicePluginTool[] {
  return names.map((name) => ({
    name,
    description: 'Read ' + name,
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
    },
  }));
}
