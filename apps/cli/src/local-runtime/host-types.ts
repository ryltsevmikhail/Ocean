/**
 * Public local-runtime host surfaces.
 *
 * Split from the composition module so the composed start path stays within the
 * source-size bound while hosts keep one public entry point.
 */

import type { ProviderPort, ProviderSecretStorePort, RuntimeRecovery } from '@runnets/application';
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
  /** Test-only deterministic clock; production omits it and uses Date.now (never wire input). */
  readonly now?: () => number;
  /** Additional host supervision joins runtime-owned execution before SQLite close. */
  readonly drain?: () => Promise<'settled' | 'uncertain'>;
  readonly drainDeadlineMs?: number;
}
