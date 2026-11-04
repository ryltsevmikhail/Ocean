/**
 * Public host surface and options for the authenticated local runtime.
 */

import type {
  ProviderPort,
  RuntimeRecovery,
  ProviderSecretStorePort,
  ServicePluginTransportPort,
} from '@runnets/application';
import type {
  LocalRuntimeIdentity,
  LocalRuntimeStatus,
  LocalRuntimeStop,
} from '@runnets/contracts';
import type { RuntimeOptions } from '../runtime.js';

export interface LocalRuntimeHost {
  readonly identity: LocalRuntimeIdentity;
  readonly recovery: RuntimeRecovery;
  readonly closed: Promise<void>;
  status(): LocalRuntimeStatus;
  stop(): Promise<LocalRuntimeStop>;
}
export interface LocalRuntimeHostOptions {
  readonly profile: string;
  readonly restore?: boolean;
  /** Host-only composition. Providers and coding authority never arrive over the wire. */
  readonly codingTools?: Pick<
    NonNullable<RuntimeOptions['codingTools']>,
    'sandbox' | 'inspectSandbox'
  >;
  /** `undefined` resolves saved/env; `null` forces every provider off; a value is read-only. */
  readonly provider?: ProviderPort | null;
  /** Test-only private credential store; production derives a profile sibling directory. */
  readonly providerSecretStore?: ProviderSecretStorePort;
  /** Explicit credential-directory override for fixtures; production is deterministic. */
  readonly credentialDir?: string;
  /** Test-only deterministic vendor transport origin; never wire input. */
  readonly providerBaseUrl?: string;
  /** Test-only deterministic service-plugin transport (deterministic fixtures only). */
  readonly pluginTransport?: ServicePluginTransportPort;
  /** Test-only environment references for plugin credentials; defaults to `process.env`. */
  readonly pluginEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Test-only loopback endpoint for the real Executor adapter against local
   * MCP/OpenAPI servers. Ignored unless the address is loopback.
   */
  readonly pluginEndpointOverride?: string;
  /** Test-only deterministic clock; production omits it and uses Date.now (never wire input). */
  readonly now?: () => number;
  /** Additional host supervision joins runtime-owned execution before SQLite close. */
  readonly drain?: () => Promise<'settled' | 'uncertain'>;
  readonly drainDeadlineMs?: number;
}
