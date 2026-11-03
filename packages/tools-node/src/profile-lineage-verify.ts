import * as fs from 'node:fs';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProfileBackupLineage } from '@runnets/domain';
import { privateAssetDirectory, assetNames } from './coding-asset-io.js';
import { verifyProfileBackupEnvelope } from './profile-backup-envelope.js';
import { verifyCodingAssetArchive } from './coding-asset-archive.js';
import { profileHash } from './profile-backup-output.js';
import { profileArchiveContext } from './profile-archive-context.js';
import { chargeProfileManifest } from './profile-backup-accounting.js';
export const lineageChain = new AsyncLocalStorage<readonly string[]>();
export function profileArchiveNames(path: string): string[] {
  const fd = privateAssetDirectory(path);
  try {
    return assetNames(fd, 10001);
  } finally {
    fs.closeSync(fd);
  }
}
export function verifyLineageArchives(root: string, lineage: ProfileBackupLineage): void {
  if (profileArchiveNames(root).join() !== 'intents,parent') throw Error('invalid_profile_lineage');
  const parent = verifyProfileBackupEnvelope(join(root, 'parent'));
  if (profileHash(parent) !== lineage.parentSnapshotId) throw Error('invalid_profile_lineage');
  const slots = lineage.intents.map((r) => profileHash(r.requestId)).sort();
  if (profileArchiveNames(join(root, 'intents')).join() !== slots.join())
    throw Error('invalid_profile_lineage');
  for (const record of lineage.intents) {
    const path = join(root, 'intents', profileHash(record.requestId));
    if (
      profileArchiveNames(path).join() !==
      record.outputs
        .filter((o) => o.presence === 'captured')
        .map((o) => o.kind)
        .sort()
        .join()
    )
      throw Error('invalid_profile_lineage');
    for (const output of record.outputs) {
      if (output.presence === 'absent') continue;
      const manifest = verifyCodingAssetArchive(join(path, output.kind));
      if (manifest.hash !== output.manifestHash) throw Error('invalid_profile_lineage');
      const budget = profileArchiveContext.getStore()?.budget;
      if (budget) chargeProfileManifest(budget, join(path, output.kind), manifest);
    }
  }
}
