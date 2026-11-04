/**
 * Public client for the runtime-owned plugin catalog, connections and grants.
 *
 * The credential VALUE never crosses this wire: connection add carries the
 * environment variable name only. Every reply is validated against the
 * versioned contract before it is returned.
 */

import {
  isLocalPluginCatalogQuery,
  isLocalPluginCatalogView,
  isLocalPluginConnectionAddRequest,
  isLocalPluginConnectionQuery,
  isLocalPluginConnectionRequest,
  isLocalPluginConnectionView,
  isLocalPluginConnections,
  isLocalPluginConsentPreview,
  isLocalPluginDiscoveryResult,
  isLocalPluginDisconnectResult,
  isLocalPluginEnableResult,
  isLocalPluginGrantFilter,
  isLocalPluginGrantPreview,
  isLocalPluginGrantRequest,
  isLocalPluginGrantView,
  isLocalPluginGrants,
  isLocalPluginInspectQuery,
  isLocalPluginInstallRequest,
  isLocalPluginInstalledView,
  isLocalPluginRevokeRequest,
  type LocalPluginCatalogQuery,
  type LocalPluginCatalogView,
  type LocalPluginConnectionAddRequest,
  type LocalPluginConnectionQuery,
  type LocalPluginConnectionRequest,
  type LocalPluginConnectionView,
  type LocalPluginConsentPreview,
  type LocalPluginDiscoveryResult,
  type LocalPluginDisconnectResult,
  type LocalPluginEnableResult,
  type LocalPluginGrantFilter,
  type LocalPluginGrantPreview,
  type LocalPluginGrantRequest,
  type LocalPluginGrantView,
  type LocalPluginInspectQuery,
  type LocalPluginInstallRequest,
  type LocalPluginInstalledView,
  type LocalPluginRevokeRequest,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';

type Send = (method: string, params: unknown, timeout?: number) => Promise<unknown>;
/** Discovery performs one bounded upstream pass; allow framing slack over the 15 s default. */
const DISCOVERY_TIMEOUT_MS = 20_000;

function catalogView(value: unknown): LocalPluginCatalogView {
  if (!isLocalPluginCatalogView(value)) throw Error('invalid_frame');
  return value;
}
function catalogViews(value: unknown): readonly LocalPluginCatalogView[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every(isLocalPluginCatalogView))
    throw Error('invalid_frame');
  return value;
}
function installedView(value: unknown): LocalPluginInstalledView {
  if (!isLocalPluginInstalledView(value)) throw Error('invalid_frame');
  return value;
}
function connectionView(value: unknown): LocalPluginConnectionView {
  if (!isLocalPluginConnectionView(value)) throw Error('invalid_frame');
  return value;
}
function connectionsView(value: unknown): readonly LocalPluginConnectionView[] {
  if (!isLocalPluginConnections(value)) throw Error('invalid_frame');
  return value;
}
function grantView(value: unknown): LocalPluginGrantView {
  if (!isLocalPluginGrantView(value)) throw Error('invalid_frame');
  return value;
}
function grantsView(value: unknown): readonly LocalPluginGrantView[] {
  if (!isLocalPluginGrants(value)) throw Error('invalid_frame');
  return value;
}

export interface LocalPluginClient {
  pluginCatalog(query?: LocalPluginCatalogQuery): Promise<readonly LocalPluginCatalogView[]>;
  pluginInspect(query: LocalPluginInspectQuery): Promise<LocalPluginCatalogView>;
  pluginInstall(request: LocalPluginInstallRequest): Promise<LocalPluginInstalledView>;
  pluginRepair(request: LocalPluginInstallRequest): Promise<LocalPluginInstalledView>;
  pluginEnable(request: LocalPluginInstallRequest): Promise<LocalPluginEnableResult>;
  pluginDisable(request: LocalPluginInspectQuery): Promise<LocalPluginInstalledView>;
  pluginConnections(): Promise<readonly LocalPluginConnectionView[]>;
  pluginConnectionAdd(request: LocalPluginConnectionAddRequest): Promise<LocalPluginConnectionView>;
  pluginConnectionPreview(query: LocalPluginConnectionQuery): Promise<LocalPluginConsentPreview>;
  pluginConnectionConsent(
    request: LocalPluginConnectionRequest,
  ): Promise<LocalPluginConsentPreview>;
  pluginConnectionDiscover(
    request: LocalPluginConnectionRequest,
  ): Promise<LocalPluginDiscoveryResult>;
  pluginConnectionDisconnect(
    request: LocalPluginConnectionQuery,
  ): Promise<LocalPluginDisconnectResult>;
  pluginAccessList(filter?: LocalPluginGrantFilter): Promise<readonly LocalPluginGrantView[]>;
  pluginAccessPreview(request: LocalPluginGrantRequest): Promise<LocalPluginGrantPreview>;
  pluginAccessGrant(request: LocalPluginGrantRequest): Promise<LocalPluginGrantView>;
  pluginAccessRevoke(request: LocalPluginRevokeRequest): Promise<LocalPluginGrantView>;
}

export function localPluginClient(send: Send): LocalPluginClient {
  return {
    async pluginCatalog(query = {}) {
      return catalogViews(
        await send('plugin.catalog', validatedParams(query, isLocalPluginCatalogQuery)),
      );
    },
    async pluginInspect(query) {
      return catalogView(
        await send('plugin.inspect', validatedParams(query, isLocalPluginInspectQuery)),
      );
    },
    async pluginInstall(request) {
      return installedView(
        await send('plugin.install', validatedParams(request, isLocalPluginInstallRequest)),
      );
    },
    async pluginRepair(request) {
      return installedView(
        await send('plugin.repair', validatedParams(request, isLocalPluginInstallRequest)),
      );
    },
    async pluginEnable(request) {
      const value = await send(
        'plugin.enable',
        validatedParams(request, isLocalPluginInstallRequest),
      );
      if (!isLocalPluginEnableResult(value)) throw Error('invalid_frame');
      return value;
    },
    async pluginDisable(request) {
      return installedView(
        await send('plugin.disable', validatedParams(request, isLocalPluginInspectQuery)),
      );
    },
    async pluginConnections() {
      return connectionsView(await send('plugin.connections', {}));
    },
    async pluginConnectionAdd(request) {
      return connectionView(
        await send(
          'plugin.connection-add',
          validatedParams(request, isLocalPluginConnectionAddRequest),
        ),
      );
    },
    async pluginConnectionPreview(query) {
      const value = await send(
        'plugin.connection-preview',
        validatedParams(query, isLocalPluginConnectionQuery),
      );
      if (!isLocalPluginConsentPreview(value)) throw Error('invalid_frame');
      return value;
    },
    async pluginConnectionConsent(request) {
      const value = await send(
        'plugin.connection-consent',
        validatedParams(request, isLocalPluginConnectionRequest),
      );
      if (!isLocalPluginConsentPreview(value)) throw Error('invalid_frame');
      return value;
    },
    async pluginConnectionDiscover(request) {
      const value = await send(
        'plugin.connection-discover',
        validatedParams(request, isLocalPluginConnectionRequest),
        DISCOVERY_TIMEOUT_MS,
      );
      if (!isLocalPluginDiscoveryResult(value)) throw Error('invalid_frame');
      return value;
    },
    async pluginConnectionDisconnect(query) {
      const value = await send(
        'plugin.connection-disconnect',
        validatedParams(query, isLocalPluginConnectionQuery),
      );
      if (!isLocalPluginDisconnectResult(value)) throw Error('invalid_frame');
      return value;
    },
    async pluginAccessList(filter = {}) {
      return grantsView(
        await send('plugin.access-list', validatedParams(filter, isLocalPluginGrantFilter)),
      );
    },
    async pluginAccessPreview(request) {
      const value = await send(
        'plugin.access-preview',
        validatedParams(request, isLocalPluginGrantRequest),
      );
      if (!isLocalPluginGrantPreview(value)) throw Error('invalid_frame');
      return value;
    },
    async pluginAccessGrant(request) {
      return grantView(
        await send('plugin.access-grant', validatedParams(request, isLocalPluginGrantRequest)),
      );
    },
    async pluginAccessRevoke(request) {
      return grantView(
        await send('plugin.access-revoke', validatedParams(request, isLocalPluginRevokeRequest)),
      );
    },
  };
}
