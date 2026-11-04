/**
 * Owner-facing catalog service for the shipped service-plugin card.
 *
 * The catalog is a frozen constant, so search/inspect/install make no network
 * request. Installation verifies the pinned manifest digest and adapter
 * compatibility, persists intent, publishes one private verified copy
 * atomically and records the version disabled. Recovery only opens versions
 * whose private copy still verifies, always disabled.
 */

import {
  canonicalJson,
  compatiblePluginAdapter,
  pluginManifestDigest,
  type PluginAdapterIdentity,
  type PluginCatalog,
  type PluginCatalogEntry,
  type PluginManifest,
} from '@runnets/domain';
import type {
  PluginCatalogStorePort,
  PluginInstallStorePort,
  PluginInstalledVersion,
  PluginServiceContext,
  PluginVersionReadPort,
} from './plugin-ports.js';
import {
  pluginCatalogView,
  pluginInstalledView,
  pluginRefuse,
  type PluginCatalogView,
  type PluginEnableResult,
  type PluginInstalledView,
  type PluginRecoveryReport,
} from './plugin-catalog-views.js';
import { recoverPluginVersions } from './plugin-catalog-recovery.js';
export interface PluginCatalogServiceOptions extends PluginServiceContext {
  readonly catalog: PluginCatalog;
  readonly store: PluginCatalogStorePort;
  readonly files: PluginInstallStorePort;
  /** Adapter build identity the host actually provides. */
  readonly adapter: PluginAdapterIdentity;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;

export class PluginCatalogService implements PluginVersionReadPort {
  readonly #catalog: PluginCatalog;
  readonly #store: PluginCatalogStorePort;
  readonly #files: PluginInstallStorePort;
  readonly #adapter: PluginAdapterIdentity;
  readonly #context: PluginServiceContext;

  constructor(options: PluginCatalogServiceOptions) {
    this.#catalog = options.catalog;
    this.#store = options.store;
    this.#files = options.files;
    this.#adapter = options.adapter;
    this.#context = {
      clock: options.clock,
      nextId: options.nextId,
      sha256: options.sha256,
      ...(options.mutationsAllowed === undefined
        ? {}
        : { mutationsAllowed: options.mutationsAllowed }),
      ...(options.restored === undefined ? {} : { restored: options.restored }),
    };
  }

  /** Startup recovery: verify private copies, mark losses, and open disabled only. */
  initialize(): PluginRecoveryReport {
    return recoverPluginVersions({
      store: this.#store,
      files: this.#files,
      adapter: this.#adapter,
      at: this.#now(),
    });
  }

  search(query?: string): readonly PluginCatalogView[] {
    const text = query?.trim().toLowerCase() ?? '';
    return this.#catalog.entries
      .filter(
        (entry) =>
          text === '' ||
          entry.pluginId.includes(text) ||
          entry.title.toLowerCase().includes(text) ||
          entry.description.toLowerCase().includes(text),
      )
      .map((entry) => pluginCatalogView(entry, this.#store, this.#files));
  }

  inspect(pluginId: string, version?: string): PluginCatalogView {
    return pluginCatalogView(this.#entry(pluginId, version), this.#store, this.#files);
  }

  installed(): readonly PluginInstalledView[] {
    return this.#store
      .plugins()
      .flatMap((pluginId) => this.#store.versions(pluginId).map(pluginInstalledView));
  }

  versions(pluginId: string): readonly PluginInstalledVersion[] {
    return this.#store.versions(pluginId);
  }

  enabled(pluginId: string): PluginInstalledVersion | null {
    return this.#store.enabled(pluginId);
  }

  /** Verify, publish one private copy and record the installed version disabled. */
  install(input: { readonly pluginId: string; readonly version?: string }): PluginInstalledView {
    this.#mutate();
    const entry = this.#entry(input.pluginId, input.version);
    this.#verifyEntry(entry);
    const existing = this.#store.version(entry.pluginId, entry.version);
    if (existing !== null && existing.state !== 'corrupt') throw pluginRefuse('already_installed');
    const manifestDigest = pluginManifestDigest(entry.manifest, this.#context.sha256);
    if (manifestDigest !== entry.manifestDigest) throw pluginRefuse('manifest_digest_mismatch');
    if (!compatiblePluginAdapter(entry.adapter, this.#adapter))
      throw pluginRefuse('adapter_incompatible');
    const at = this.#now();
    const intent: PluginInstalledVersion = {
      pluginId: entry.pluginId,
      version: entry.version,
      publisher: entry.publisher,
      title: entry.title,
      manifest: entry.manifest,
      manifestDigest,
      adapter: entry.adapter,
      state: 'installing',
      enabled: false,
      fileDigest: null,
      installedAt: at,
      verifiedAt: null,
    };
    // Intent is durable before the filesystem effect and before any later failure path.
    this.#store.beginInstall(intent);
    let file;
    try {
      file =
        existing === null
          ? this.#files.publish(entry.pluginId, entry.version, entry.manifest)
          : this.#files.repair(entry.pluginId, entry.version, entry.manifest);
    } catch {
      this.#store.setState(entry.pluginId, entry.version, 'interrupted');
      throw pluginRefuse('install_failed');
    }
    if (file.sha256 !== manifestDigest || file.relativePath !== 'manifest.json') {
      this.#store.setState(entry.pluginId, entry.version, 'corrupt');
      throw pluginRefuse('install_unverified');
    }
    const read = this.#files.read(entry.pluginId, entry.version);
    if (read.status !== 'ok' || read.sha256 !== manifestDigest) {
      this.#store.setState(entry.pluginId, entry.version, 'corrupt');
      throw pluginRefuse('install_unverified');
    }
    if (!this.#store.markVerified(entry.pluginId, entry.version, file, at))
      throw pluginRefuse('install_failed');
    return pluginInstalledView(this.#store.version(entry.pluginId, entry.version)!);
  }

  /**
   * Explicit owner repair for a corrupt/interrupted install. Replaces the
   * unverified private copy with a freshly verified one from the pinned card,
   * re-verifies it and records the version installed and disabled. A verified
   * install is never touched; a concurrent install intent is refused.
   */
  repair(input: { readonly pluginId: string; readonly version?: string }): PluginInstalledView {
    this.#mutate();
    const entry = this.#entry(input.pluginId, input.version);
    this.#verifyEntry(entry);
    const existing = this.#store.version(entry.pluginId, entry.version);
    if (existing === null) throw pluginRefuse('not_installed');
    if (existing.state === 'installing') throw pluginRefuse('install_in_progress');
    if (existing.state === 'installed') throw pluginRefuse('already_installed');
    const manifestDigest = pluginManifestDigest(entry.manifest, this.#context.sha256);
    if (manifestDigest !== entry.manifestDigest) throw pluginRefuse('manifest_digest_mismatch');
    if (!compatiblePluginAdapter(entry.adapter, this.#adapter))
      throw pluginRefuse('adapter_incompatible');
    const at = this.#now();
    this.#store.beginInstall({
      ...existing,
      pluginId: entry.pluginId,
      version: entry.version,
      publisher: entry.publisher,
      title: entry.title,
      manifest: entry.manifest,
      manifestDigest,
      adapter: entry.adapter,
      state: 'installing',
      enabled: false,
      fileDigest: null,
      verifiedAt: null,
    });
    let file;
    try {
      file = this.#files.repair(entry.pluginId, entry.version, entry.manifest);
    } catch {
      this.#store.setState(entry.pluginId, entry.version, 'interrupted');
      throw pluginRefuse('install_failed');
    }
    if (file.sha256 !== manifestDigest || file.relativePath !== 'manifest.json') {
      this.#store.setState(entry.pluginId, entry.version, 'corrupt');
      throw pluginRefuse('install_unverified');
    }
    const read = this.#files.read(entry.pluginId, entry.version);
    if (read.status !== 'ok' || read.sha256 !== manifestDigest) {
      this.#store.setState(entry.pluginId, entry.version, 'corrupt');
      throw pluginRefuse('install_unverified');
    }
    if (!this.#store.markVerified(entry.pluginId, entry.version, file, at))
      throw pluginRefuse('install_failed');
    return pluginInstalledView(this.#store.version(entry.pluginId, entry.version)!);
  }

  enable(input: { readonly pluginId: string; readonly version?: string }): PluginEnableResult {
    this.#mutate();
    const entry = this.#entry(input.pluginId, input.version);
    this.#verifyEntry(entry);
    const record = this.#store.version(entry.pluginId, entry.version);
    if (record === null) throw pluginRefuse('not_installed');
    if (record.state !== 'installed') throw pluginRefuse('install_not_verified');
    if (!compatiblePluginAdapter(record.adapter, this.#adapter))
      throw pluginRefuse('adapter_incompatible');
    this.#verifyFile(record);
    const at = this.#now();
    const previous = this.#store.enabled(record.pluginId);
    const switching = previous !== null && previous.version !== record.version;
    const revokedGrants = this.#store.setEnabled(
      record.pluginId,
      record.version,
      true,
      at,
      switching,
    );
    return {
      installed: pluginInstalledView(this.#store.version(record.pluginId, record.version)!),
      revokedGrants,
    };
  }

  disable(input: { readonly pluginId: string }): PluginInstalledView {
    this.#mutate();
    const entry = this.#entry(input.pluginId, undefined);
    this.#verifyEntry(entry);
    const enabled = this.#store.enabled(entry.pluginId);
    if (enabled === null) throw pluginRefuse('not_installed');
    // Disabling is an owner revocation action: dormant grants must not silently
    // reactivate on a later same-version enable.
    this.#store.setEnabled(entry.pluginId, enabled.version, false, this.#now(), true);
    return pluginInstalledView(this.#store.version(entry.pluginId, enabled.version)!);
  }

  #verifyFile(record: PluginInstalledVersion): void {
    const read = this.#files.read(record.pluginId, record.version);
    if (read.status !== 'ok' || read.sha256 !== record.manifestDigest) {
      this.#store.setState(record.pluginId, record.version, 'corrupt');
      this.#store.setEnabled(record.pluginId, record.version, false, this.#now(), true);
      throw pluginRefuse('install_corrupt');
    }
  }

  #entry(pluginId: string, version?: string): PluginCatalogEntry {
    const candidates = this.#catalog.entries.filter((entry) => entry.pluginId === pluginId);
    if (candidates.length === 0) throw pluginRefuse('unknown_plugin');
    const entry =
      version === undefined
        ? candidates[0]
        : candidates.find((candidate) => candidate.version === version);
    if (entry === undefined) throw pluginRefuse('unknown_version');
    return entry;
  }

  #verifyEntry(entry: PluginCatalogEntry): void {
    const manifest: PluginManifest = entry.manifest;
    if (
      !VERSION.test(entry.version) ||
      manifest.schemaVersion !== 1 ||
      manifest.pluginId !== entry.pluginId ||
      manifest.version !== entry.version ||
      manifest.publisher !== entry.publisher ||
      manifest.readOnly !== true ||
      manifest.resourceConstraint !== 'repository' ||
      manifest.authentication !== 'environment-reference' ||
      manifest.operations.length === 0
    )
      throw pluginRefuse('invalid_manifest');
    if (entry.manifestDigest !== this.#context.sha256(canonicalJson(manifest)))
      throw pluginRefuse('manifest_digest_mismatch');
  }

  #mutate(): void {
    if (this.#context.mutationsAllowed === false) throw pluginRefuse('restore_restricted');
  }

  #now(): string {
    return this.#context.clock.now().toISOString();
  }
}
