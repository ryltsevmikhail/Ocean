/**
 * Startup recovery for the installed plugin catalog.
 *
 * Only a version whose private copy still hashes to the pinned manifest digest
 * is reopened, and every reopened version is disabled. Corrupt/interrupted
 * versions, and adapters that no longer match the pin, revoke old authority.
 */

import { compatiblePluginAdapter, type PluginAdapterIdentity } from '@runnets/domain';
import type { PluginCatalogStorePort, PluginInstallStorePort } from './plugin-ports.js';
import type { PluginRecoveryReport } from './plugin-catalog-views.js';

export function recoverPluginVersions(input: {
  readonly store: PluginCatalogStorePort;
  readonly files: PluginInstallStorePort;
  readonly adapter: PluginAdapterIdentity;
  readonly at: string;
}): PluginRecoveryReport {
  const store = input.store;
  const files = input.files;
  const at = input.at;
  let interrupted = 0,
    repaired = 0,
    verified = 0,
    corrupt = 0,
    disabled = 0,
    revokedGrants = 0;
  for (const pluginId of store.plugins()) {
    for (const record of store.versions(pluginId)) {
      let current = record;
      if (current.state === 'installing') {
        store.setState(current.pluginId, current.version, 'interrupted');
        current = { ...current, state: 'interrupted' };
        interrupted++;
      }
      if (current.state === 'corrupt') {
        // A copy repaired outside this run (for example an owner restore) may
        // verify again; otherwise corrupt stays terminal until explicit repair.
        const recheck = files.read(current.pluginId, current.version);
        if (recheck.status !== 'ok' || recheck.sha256 !== current.manifestDigest) {
          corrupt++;
          if (current.enabled)
            revokedGrants += store.setEnabled(current.pluginId, current.version, false, at, true);
          continue;
        }
        store.markVerified(
          current.pluginId,
          current.version,
          { relativePath: 'manifest.json', sha256: recheck.sha256, bytes: recheck.bytes },
          at,
        );
        current = {
          ...current,
          state: 'installed',
          fileDigest: recheck.sha256,
          verifiedAt: at,
        };
        repaired++;
      }
      const file = files.read(current.pluginId, current.version);
      if (file.status !== 'ok' || file.sha256 !== current.manifestDigest) {
        store.setState(current.pluginId, current.version, 'corrupt');
        corrupt++;
        if (current.enabled)
          revokedGrants += store.setEnabled(current.pluginId, current.version, false, at, true);
        continue;
      }
      if (current.state !== 'installed') {
        store.markVerified(
          current.pluginId,
          current.version,
          { relativePath: 'manifest.json', sha256: file.sha256, bytes: file.bytes },
          at,
        );
        current = {
          ...current,
          state: 'installed',
          fileDigest: file.sha256,
          verifiedAt: at,
        };
        interrupted++;
      }
      verified++;
      // A restart never resumes an enabled version: verified versions open disabled.
      // Opening an interrupted authority also revokes its dormant grants and
      // confirmations, so a later same-version enable cannot silently restore access
      // the owner has not re-granted. An adapter build that no longer matches the
      // pinned card is equally unusable and revokes its authority.
      if (current.enabled || !compatiblePluginAdapter(current.adapter, input.adapter)) {
        revokedGrants += store.setEnabled(current.pluginId, current.version, false, at, true);
        if (current.enabled) disabled++;
      }
    }
  }
  return { interrupted, repaired, verified, corrupt, disabled, revokedGrants };
}
