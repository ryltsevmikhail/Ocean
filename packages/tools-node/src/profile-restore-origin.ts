import { join } from 'node:path';
import type { ProfileBackupManifest } from '@runnets/domain';
import { profileArchiveContext } from './profile-archive-context.js';
import { copyProfileBackupDatabase } from './profile-backup-copy.js';
import { ProfileBackupOutput, profileHash } from './profile-backup-output.js';
import { profileBackupDatabaseIdentity } from './profile-backup-envelope.js';
import { profileManifestCharge } from './profile-backup-accounting.js';
import { copyEvidence } from './profile-backup-restore.js';
import { withProfileArchive } from './profile-backup-verify.js';

/** Called inside envelope verification: the extra copy is charged before output creation. */
export function preserveProfileRestoreOrigin(
  source: string,
  destination: string,
  manifest: Extract<ProfileBackupManifest, { format: 2 }>,
): void {
  const context = profileArchiveContext.getStore();
  if (!context?.roots.some((r) => r.capture.root === source))
    throw Error('unverified_restore_origin');
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  context.budget.charge('restore-origin:' + destination, {
    stored: manifest.bytes + bytes,
    logical: manifest.bytes + bytes,
    entries: 4,
    metadata: bytes,
  });
  const output = new ProfileBackupOutput(destination);
  try {
    copyProfileBackupDatabase(join(source, 'runtime.sqlite'), output, manifest);
    output.write('snapshot.json', manifest);
    if (
      profileHash(profileBackupDatabaseIdentity(join(destination, 'runtime.sqlite'))) !==
      profileHash({ bytes: manifest.bytes, sha256: manifest.sha256 })
    )
      throw Error('invalid_restore_origin');
    output.publish();
  } finally {
    output.close();
  }
}

/** Full lineage tree copy: every parent envelope and pre-ready output occurrence is charged again. */
export function preserveProfileRestoreLineage(
  source: string,
  destination: string,
  manifest: Extract<ProfileBackupManifest, { format: 2 }>,
): void {
  if (!manifest.lineage) throw Error('invalid_profile_backup');
  const context = profileArchiveContext.getStore();
  if (!context?.roots.some((r) => r.capture.root === source))
    throw Error('unverified_restore_origin');
  withProfileArchive(join(source, 'lineage'), (capture) => {
    const charge = profileManifestCharge(capture.manifest);
    context.budget.charge('restore-lineage:' + destination, {
      ...charge,
      metadata: charge.metadata + 4096,
    });
    const output = copyEvidence(capture, destination);
    try {
      output.publish();
    } finally {
      output.close();
    }
  });
}
