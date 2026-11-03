import type { CodingAssetManifest } from '@runnets/domain';
import type { ProfileBackupBudget } from './profile-backup-session.js';
/** Each retained logical name counts, including hardlinks and each independent archive occurrence. */
export function profileManifestCharge(manifest: CodingAssetManifest) {
  const entries = new Map(manifest.entries.map((e) => [e.path, e]));
  return {
    stored: manifest.bytes,
    logical: manifest.entries.reduce((n, e) => {
      const file = e.kind === 'hardlink' ? entries.get(e.target) : e;
      return n + (file?.kind === 'file' ? file.bytes : 0);
    }, 0),
    entries: manifest.entries.length,
    metadata: Buffer.byteLength(JSON.stringify(manifest)),
  };
}
export function chargeProfileManifest(
  budget: ProfileBackupBudget,
  key: string,
  manifest: CodingAssetManifest,
): void {
  const { stored: _stored, ...logical } = profileManifestCharge(manifest);
  budget.charge('materialization:' + key, logical);
}
