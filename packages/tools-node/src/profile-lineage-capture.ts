import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import type { ProfileBackupLineage } from '@runnets/domain';
import { ProfileBackupOutput, profileHash } from './profile-backup-output.js';
import { copyProfileBackupDatabase } from './profile-backup-copy.js';
import { copyEvidence } from './profile-backup-restore.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import { archiveLineageFile, readLineageFile } from './profile-lineage-file.js';
import type { PreparedProfileLineage } from './profile-lineage-preparation.js';

/** Writes the complete parent envelope and each exact pre-ready output inside the held source lifetime. */
export function captureProfileLineage(
  prepared: PreparedProfileLineage,
  destination: string,
): ProfileBackupLineage {
  const lineageRoot = join(destination, 'lineage');
  fs.mkdirSync(lineageRoot, { mode: 0o700 });
  const parent = new ProfileBackupOutput(join(lineageRoot, 'parent'));
  try {
    copyProfileBackupDatabase(prepared.parent.database, parent, prepared.parent.manifest);
    parent.write('snapshot.json', prepared.parent.manifest);
    const assets = copyEvidence(prepared.parent.assetsCapture, join(parent.path, 'assets'));
    try {
      assets.publish();
    } finally {
      assets.close();
    }
    if (prepared.parent.lineageCapture) {
      const tree = copyEvidence(prepared.parent.lineageCapture, join(parent.path, 'lineage'));
      try {
        tree.publish();
      } finally {
        tree.close();
      }
    }
    parent.publish();
  } finally {
    parent.close();
  }
  fs.mkdirSync(join(lineageRoot, 'intents'), { mode: 0o700 });
  const intents = prepared.intents.map((intent) => {
    const directory = join(lineageRoot, 'intents', profileHash(intent.requestId));
    fs.mkdirSync(directory, { mode: 0o700 });
    const outputs = intent.outputs.map((output) => {
      const present = output.path
        ? fs.lstatSync(output.path, { throwIfNoEntry: false }) !== undefined
        : false;
      if (output.presence === 'absent') {
        if (present) throw Error('lineage_output_changed');
        return { kind: output.kind, presence: 'absent' as const, manifestHash: null };
      }
      if (!output.path || !present) throw Error('missing_rebind_output');
      let manifestHash: string;
      if (output.capture) {
        manifestHash = archiveCodingAssetTree(output.capture, join(directory, output.kind)).hash;
      } else {
        const fresh = readLineageFile(output.path, basename(output.path), 1048576);
        if (!output.file || fresh.manifest.hash !== output.file.manifest.hash)
          throw Error('stale_coding_asset');
        manifestHash = archiveLineageFile(output.file, join(directory, output.kind));
      }
      return { kind: output.kind, presence: 'captured' as const, manifestHash };
    });
    return {
      requestId: intent.requestId,
      recordHash: intent.recordHash,
      state: intent.state,
      outputs,
    };
  });
  return { ...prepared.lineage, intents };
}
