/* eslint-disable no-restricted-imports -- Test-only fixture for the application package's own plugin services. */
import { createHash } from 'node:crypto';
import {
  SHIPPED_PLUGIN_CATALOG,
  canonicalJson,
  type PluginAdapterIdentity,
  type PluginCatalog,
  type PluginCatalogEntry,
} from '@runnets/domain';
import { PluginCatalogService } from '../src/plugin-catalog.js';
import { PluginConnectionService } from '../src/plugin-connections.js';
import { PluginAccessService } from '../src/plugin-access.js';
import { PluginCallAdmissionService } from '../src/plugin-admission.js';
import { pluginToolsDigest } from '../src/plugin-json.js';
import type {
  ServicePluginCatalog,
  ServicePluginTarget,
  ServicePluginTool,
} from '../src/service-plugin-transport.js';
import {
  fakePluginTransport,
  pluginFixtureState,
  tools as toolList,
  type FakeTransport,
} from './plugin-fakes.js';

export const PINNED_ADAPTER: PluginAdapterIdentity = {
  adapter: 'runnets-executor',
  protocolVersion: 1,
  sdkVersion: '1.6.11',
  manifestSchemaVersion: 1,
};
export const WORKS_IN_ROOM = 'OCEAN_TEST_PRESENT';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function shippedTools(): readonly ServicePluginTool[] {
  return toolList(SHIPPED_PLUGIN_CATALOG.entries[0]!.manifest.operations.map((o) => o.tool));
}

export function catalogFixture(
  target: ServicePluginTarget,
  overrides: {
    tools?: readonly ServicePluginTool[];
    identity?: { identity: string | null; verified: boolean };
    completenessSuccess?: boolean;
  } = {},
): ServicePluginCatalog {
  const tools = overrides.tools ?? shippedTools();
  return {
    target,
    tools,
    schemaDigest: pluginToolsDigest(tools, sha256, canonicalJson),
    account: overrides.identity ?? { identity: null, verified: false },
    discoveredAt: '2026-11-04T00:00:00.000Z',
    completeness: 'complete',
  };
}

export function serviceFixture(
  options: {
    adapter?: PluginAdapterIdentity;
    transport?: FakeTransport;
    mutationsAllowed?: boolean;
    restored?: boolean;
    catalog?: PluginCatalog;
  } = {},
) {
  const state = pluginFixtureState();
  let adapter = options.adapter ?? PINNED_ADAPTER;
  const time = { now: '2026-11-04T00:00:00.000Z' };
  let ids = 0;
  const context = {
    clock: { now: () => new Date(time.now) },
    nextId: () => 'id' + String(++ids).padStart(6, '0'),
    sha256,
    ...(options.mutationsAllowed === undefined
      ? {}
      : { mutationsAllowed: options.mutationsAllowed }),
    ...(options.restored === undefined ? {} : { restored: options.restored }),
  };
  const transport =
    options.transport ??
    fakePluginTransport(
      () => {
        throw new Error('test transport has no catalog configured');
      },
      () => ({
        kind: 'observed',
        invocationId: 'inv',
        code: 'ok',
        result: { ok: true },
        vendorErrorCode: null,
      }),
    );
  const build = () => {
    const catalogService = new PluginCatalogService({
      catalog: options.catalog ?? SHIPPED_PLUGIN_CATALOG,
      store: state.catalog,
      files: state.installFiles,
      adapter,
      ...context,
    });
    catalogService.initialize();
    const connections = new PluginConnectionService({
      store: state.connections,
      versions: catalogService,
      transport,
      credentials: state.credentials,
      adapter,
      ...context,
    });
    connections.initialize();
    const access = new PluginAccessService({ store: state.access, ...context });
    const admission = new PluginCallAdmissionService({
      store: state.admission,
      transport,
      credentials: state.credentials,
      adapter,
    });
    return { catalogService, connections, access, admission };
  };
  const services = build();
  const fixture = {
    restartWithAdapter(next: PluginAdapterIdentity) {
      adapter = next;
      const after = build();
      return {
        catalog: after.catalogService,
        connections: after.connections,
        access: after.access,
        admission: after.admission,
        transport,
        state,
      };
    },
    state,
    transport,
    adapter,
    time,
    get catalog() {
      return services.catalogService;
    },
    get connections() {
      return services.connections;
    },
    get access() {
      return services.access;
    },
    get admission() {
      return services.admission;
    },
    /** Simulate a runtime restart: same durable rows, fresh services. */
    restart(next: { adapter?: PluginAdapterIdentity } = {}) {
      const servicesAfter = build();
      if (next.adapter) fixture.adapter = next.adapter;
      return {
        ...servicesAfter,
        transport,
        state,
      };
    },
    advance(iso: string) {
      time.now = iso;
    },
    installAndEnable() {
      fixture.catalog.install({ pluginId: 'github' });
      return fixture.catalog.enable({ pluginId: 'github' });
    },
    connect(input: { name?: string; credentialReference?: string; accountLabel?: string } = {}) {
      return fixture.connections.add({
        name: input.name ?? 'work',
        pluginId: 'github',
        credentialReference: input.credentialReference ?? WORKS_IN_ROOM,
        ...(input.accountLabel === undefined ? {} : { accountLabel: input.accountLabel }),
      });
    },
    discoverWith(
      connectionId: string,
      generator: (target: ServicePluginTarget) => ServicePluginCatalog,
    ) {
      const previous = transport.catalog;
      transport.catalog = () => generator({ integrationId: 'github', connectionId, owner: 'user' });
      return { restore: () => (transport.catalog = previous) };
    },
    /** Full happy path used by many tests: install, enable, connect, consent, discover. */
    async readyWorkingConnection(input: { name?: string } = {}) {
      fixture.installAndEnable();
      const connection = fixture.connect(input);
      fixture.connections.consent({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      });
      transport.catalog = () =>
        catalogFixture({ integrationId: 'github', connectionId: connection.id, owner: 'user' });
      const result = await fixture.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      });
      return result.connection;
    },
  };
  return fixture;
}

export { pluginFixtureState };

/** Two frozen versions of the same declarative card, for version-switch tests. */
export function twoVersionCatalog(): PluginCatalog {
  const first = SHIPPED_PLUGIN_CATALOG.entries[0]!;
  const second: PluginCatalogEntry = {
    ...first,
    version: '1.1.0',
    manifest: { ...first.manifest, version: '1.1.0' },
    manifestDigest: '',
  };
  const manifestDigest = createHash('sha256').update(canonicalJson(second.manifest)).digest('hex');
  return {
    schemaVersion: 1,
    entries: [first, { ...second, manifestDigest }],
  };
}
