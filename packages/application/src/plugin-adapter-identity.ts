/**
 * Adapter identity derived from the qualified transport.
 *
 * A connection row stores the adapter build identity it was observed under. The
 * host must never hardcode that identity: the variable part (the pinned SDK
 * version) comes from `qualification().identities`, and the Ocean protocol
 * fields come from the frozen catalog card. An unqualified transport yields no
 * identity, so no connection can be observed or dispatched against it.
 */

import type { PluginAdapterCompatibility, PluginAdapterIdentity } from '@runnets/domain';
import type { ServicePluginTransportQualification } from './service-plugin-transport.js';

/** The pinned package identities the qualified transport reports. */
export const EXECUTOR_SDK_IDENTITY_KEY = '@executor-js/sdk';

/**
 * Build the adapter identity this host actually provides, or null when the
 * transport is not qualified (execution disabled / pinned artifact mismatch).
 */
export function pluginAdapterIdentityFrom(
  qualification: ServicePluginTransportQualification,
  protocol: Pick<
    PluginAdapterCompatibility,
    'adapter' | 'protocolVersion' | 'manifestSchemaVersion'
  >,
): PluginAdapterIdentity | null {
  if (qualification.qualified !== true || qualification.reason !== null) return null;
  const sdkVersion = qualification.identities[EXECUTOR_SDK_IDENTITY_KEY];
  if (typeof sdkVersion !== 'string' || sdkVersion.trim().length === 0) return null;
  return {
    adapter: protocol.adapter,
    protocolVersion: protocol.protocolVersion,
    sdkVersion,
    manifestSchemaVersion: protocol.manifestSchemaVersion,
  };
}
