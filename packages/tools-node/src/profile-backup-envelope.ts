import { checkProfileArchiveFile } from './profile-archive-context.js';
import { assertProfileBackupOutput, type ProfileBackupOutput } from './profile-backup-output.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validProfileBackupManifest, type ProfileBackupManifest } from '@runnets/domain';
import { privateAssetDirectory, assetNames } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { verifyProfileAssetArchive, withProfileArchive } from './profile-backup-verify.js';
import { codingAssetIdentity } from './coding-asset-state.js';
import { lineageChain, verifyLineageArchives } from './profile-lineage-verify.js';
export function profileBackupDatabaseIdentity(path: string) {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    checkProfileArchiveFile(fd);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid!()) ||
      (stat.mode & 0o777n) !== 0o600n ||
      stat.size > 2147483648n
    )
      throw Error('invalid_profile_backup');
    const buffer = Buffer.alloc(1048576),
      hash = createHash('sha256');
    let offset = 0;
    while (offset < Number(stat.size)) {
      const n = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, Number(stat.size) - offset),
        offset,
      );
      if (!n) throw Error('invalid_profile_backup');
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    if (
      codingAssetIdentity(stat) !== codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) ||
      codingAssetIdentity(stat) !== codingAssetIdentity(fs.lstatSync(path, { bigint: true }))
    )
      throw Error('stale_coding_asset');
    return { bytes: offset, sha256: hash.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}
function verifyEnvelope(
  directory: string,
  incomplete = false,
  consume?: (manifest: Extract<ProfileBackupManifest, { format: 2 }>) => void,
): Extract<ProfileBackupManifest, { format: 2 }> {
  return withProfileArchive(directory, () => {
    const root = privateAssetDirectory(directory);
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        readDesktopArchiveFile(root, 'snapshot.json', 33554432).toString('utf8'),
      ) as unknown;
      if (
        !validProfileBackupManifest(manifest) ||
        manifest.format !== 2 ||
        assetNames(root, 6).join() !==
          [
            ...(incomplete ? ['.incomplete'] : []),
            'assets',
            ...(manifest.lineage ? ['lineage'] : []),
            'runtime.sqlite',
            'snapshot.json',
          ]
            .sort()
            .join()
      )
        throw Error('invalid_profile_backup');
    } finally {
      fs.closeSync(root);
    }
    if (!validProfileBackupManifest(manifest) || manifest.format !== 2)
      throw Error('invalid_profile_backup');
    const id = createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      chain = lineageChain.getStore() ?? [];
    if (chain.length >= 8 || chain.includes(id)) throw Error('profile_lineage_limit');
    const database = profileBackupDatabaseIdentity(join(directory, 'runtime.sqlite'));
    if (database.bytes !== manifest.bytes || database.sha256 !== manifest.sha256)
      throw Error('invalid_profile_backup');
    verifyProfileAssetArchive(
      join(directory, 'assets'),
      manifest.assets,
      incomplete && fs.existsSync(join(directory, 'assets', '.incomplete')),
    );
    if (manifest.lineage)
      lineageChain.run([...chain, id], () =>
        verifyLineageArchives(join(directory, 'lineage'), manifest.lineage!),
      );
    consume?.(manifest);
    return manifest;
  });
}

export function verifyProfileBackupEnvelope(
  directory: string,
  consume?: (manifest: Extract<ProfileBackupManifest, { format: 2 }>) => void,
): Extract<ProfileBackupManifest, { format: 2 }> {
  return verifyEnvelope(directory, false, consume);
}
export function verifyProfileBackupOutput(
  output: ProfileBackupOutput,
  consume?: (manifest: Extract<ProfileBackupManifest, { format: 2 }>) => void,
): Extract<ProfileBackupManifest, { format: 2 }> {
  assertProfileBackupOutput(output);
  return verifyEnvelope(output.path, true, consume);
}
