/**
 * Durable plugin composition for the direct profile host.
 *
 * Keeps `runtime.ts` inside the 300-line source bound: the runtime owns the
 * stores, this module turns them into the shared plugin services that power
 * normal chat tools, broadcast children and the owner operation views.
 */

import type { SqliteStore } from '@runnets/store-sqlite';
import {
  composePluginRuntime,
  type ComposePluginRuntimeOptions,
  type PluginRuntime,
} from './plugin-runtime.js';

/** Durable store slice the runtime already owns. */
export type RuntimePluginStores = Pick<
  SqliteStore,
  'pluginCatalog' | 'pluginConnections' | 'pluginAccess' | 'pluginAdmission' | 'pluginOperations'
>;

export interface ComposeRuntimePluginsInput extends Omit<
  ComposePluginRuntimeOptions,
  'profile' | 'stores' | 'mutationsAllowed'
> {
  readonly profile: string;
  readonly store: RuntimePluginStores;
  readonly mutationsAllowed?: boolean | undefined;
}

/** Compose plugin services over the runtime's authoritative durable stores. */
export function composeRuntimePlugins(input: ComposeRuntimePluginsInput): PluginRuntime {
  return composePluginRuntime({
    profile: input.profile,
    stores: {
      catalog: input.store.pluginCatalog,
      connections: input.store.pluginConnections,
      access: input.store.pluginAccess,
      admission: input.store.pluginAdmission,
      operations: input.store.pluginOperations,
    },
    clock: input.clock,
    restored: input.restored,
    ...(input.mutationsAllowed === undefined ? {} : { mutationsAllowed: input.mutationsAllowed }),
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
  });
}
