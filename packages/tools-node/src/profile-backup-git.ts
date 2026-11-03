import type { ProfileBackupBudget } from './profile-backup-session.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { CodingGitObjectCapture } from './coding-git-backup.js';
import { ProfileBackupOutput } from './profile-backup-output.js';
import { privateAssetDirectory, assetNames } from './coding-asset-io.js';
import { readDesktopArchiveFile } from './desktop-archive-verify.js';
import { verifyCodingGitPack } from './coding-git-verify.js';
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export function archiveProfileGit(capture: CodingGitObjectCapture, destination: string): string {
  const { index, pack, ...body } = capture,
    manifest = Buffer.from(
      JSON.stringify({ ...body, indexBytes: index.length, packBytes: pack.length }),
    ),
    digest = sha(manifest),
    output = new ProfileBackupOutput(destination);
  try {
    output.writeBytes('index', index);
    output.writeBytes('pack', pack);
    output.writeBytes('manifest.json', manifest);
    verifyProfileGit(destination, digest, true);
    output.publish();
    return digest;
  } finally {
    output.close();
  }
}
export function verifyProfileGit(
  directory: string,
  digest: string,
  incomplete = false,
  budget?: ProfileBackupBudget,
): CodingGitObjectCapture {
  const root = privateAssetDirectory(directory);
  try {
    if (
      assetNames(root, 5).join() !==
      (incomplete ? '.incomplete,index,manifest.json,pack' : 'index,manifest.json,pack')
    )
      throw Error('invalid_profile_git');
    const bytes = readDesktopArchiveFile(root, 'manifest.json', 8388608, digest),
      value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join() !==
        'baseCommit,format,indexBytes,indexSha256,objectBytes,objectFormat,objectIds,packBytes,packSha256' ||
      value['format'] !== 1 ||
      !['sha1', 'sha256'].includes(String(value['objectFormat'])) ||
      typeof value['baseCommit'] !== 'string' ||
      !new RegExp('^[a-f0-9]{' + (value['objectFormat'] === 'sha1' ? 40 : 64) + '}$').test(
        value['baseCommit'],
      ) ||
      !Array.isArray(value['objectIds']) ||
      value['objectIds'].length > 100000 ||
      !value['objectIds'].every((id) => typeof id === 'string') ||
      !['indexSha256', 'packSha256'].every(
        (k) => typeof value[k] === 'string' && /^[a-f0-9]{64}$/.test(value[k]),
      ) ||
      ![
        ['indexBytes', 16777216],
        ['packBytes', 268435456],
        ['objectBytes', 2147483648],
      ].every(
        ([key, limit]) =>
          Number.isSafeInteger(value[String(key)]) &&
          Number(value[String(key)]) >= 0 &&
          Number(value[String(key)]) <= Number(limit),
      )
    )
      throw Error('invalid_profile_git');
    const accountingKey = 'git:' + directory;
    budget?.charge(accountingKey, {
      logical: Number(value['objectBytes']),
      entries: (value['objectIds'] as unknown[]).length,
    });
    const index = readDesktopArchiveFile(root, 'index', 16777216, String(value['indexSha256'])),
      pack = readDesktopArchiveFile(root, 'pack', 268435456, String(value['packSha256']));
    if (index.length !== value['indexBytes'] || pack.length !== value['packBytes'])
      throw Error('invalid_profile_git');
    const capture: CodingGitObjectCapture = {
      format: 1,
      baseCommit: value['baseCommit'],
      objectFormat: value['objectFormat'] as 'sha1' | 'sha256',
      objectIds: value['objectIds'],
      objectBytes: Number(value['objectBytes']),
      index,
      pack,
      indexSha256: String(value['indexSha256']),
      packSha256: String(value['packSha256']),
    };
    verifyCodingGitPack(capture, index, (logical) => budget?.charge(accountingKey, { logical }));
    return capture;
  } finally {
    fs.closeSync(root);
  }
}
/** Copy already verified inert Git evidence, never import it into a project or invoke checkout. */
export function restoreProfileGit(source: string, destination: string, digest: string): void {
  const capture = verifyProfileGit(source, digest);
  archiveProfileGit(capture, destination);
  if (verifyProfileGit(source, digest).packSha256 !== capture.packSha256)
    throw Error('stale_coding_asset');
}
