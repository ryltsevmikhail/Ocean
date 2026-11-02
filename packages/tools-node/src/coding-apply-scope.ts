import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CodingApplyContext } from '@runnets/domain';
import {
  assetDirectoryFlags,
  assetFdPath,
  checkAssetPath,
  readAssetBlob,
} from './coding-asset-io.js';
export function codingApplyRecoveryScope(root: string, context: CodingApplyContext) {
  const { ownerId, taskId, applicationId, changesetHash } = context;
  if (
    root !== resolve(root) ||
    root.includes('\0') ||
    Buffer.byteLength(root) > 4096 ||
    [ownerId, taskId, applicationId].some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        Buffer.byteLength(value) > 1024 ||
        value.includes('\0') ||
        Buffer.from(value).toString('utf8') !== value,
    ) ||
    typeof changesetHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(changesetHash)
  )
    throw Error('invalid_coding_apply_scope');
  return { version: 2 as const, root, ownerId, taskId, applicationId, changesetHash };
}
export function codingApplyRecoverySlot(root: string, context: CodingApplyContext): string {
  return createHash('sha256')
    .update(JSON.stringify(codingApplyRecoveryScope(root, context)))
    .digest('hex');
}
function child(
  parent: number,
  name: string,
  canonical: string,
  create: boolean,
): { fd: number; created: boolean } {
  let created = false;
  checkAssetPath(parent, canonical.slice(0, -(name.length + 1)));
  if (create)
    try {
      fs.mkdirSync(join(assetFdPath(parent), name), { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  const fd = fs.openSync(join(assetFdPath(parent), name), assetDirectoryFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.uid !== process.getuid?.() || stat.mode & 0o7077)
      throw Error('invalid_coding_apply_scope');
    checkAssetPath(fd, canonical);
    fs.fsyncSync(parent);
    return { fd, created };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
/** Caller has durably recorded the exact file as started. Existing incomplete scope is never repaired. */
export function prepareCodingApplyRecovery(
  common: string,
  root: string,
  context: CodingApplyContext,
): string {
  const scope = codingApplyRecoveryScope(root, context),
    slot = codingApplyRecoverySlot(root, context);
  if (
    process.platform !== 'linux' ||
    fs.realpathSync(common) !== common ||
    fs.realpathSync(root) !== root
  )
    throw Error('invalid_coding_apply_scope');
  const commonFd = fs.openSync(common, assetDirectoryFlags);
  let parent: number | undefined, leaf: number | undefined, files: number | undefined;
  try {
    if (fs.fstatSync(commonFd).uid !== process.getuid?.())
      throw Error('invalid_coding_apply_scope');
    checkAssetPath(commonFd, common);
    const parentPath = join(common, 'ocean-apply-recovery-v2');
    parent = child(commonFd, 'ocean-apply-recovery-v2', parentPath, true).fd;
    const leafPath = join(parentPath, slot),
      opened = child(parent, slot, leafPath, true);
    leaf = opened.fd;
    const body = Buffer.from(JSON.stringify(scope) + '\n');
    if (opened.created) {
      const record = fs.openSync(join(assetFdPath(leaf), 'scope.json'), 'wx', 0o600);
      try {
        fs.writeFileSync(record, body);
        fs.fsyncSync(record);
      } finally {
        fs.closeSync(record);
      }
      fs.fsyncSync(leaf);
    } else if (
      readAssetBlob(leaf, 'scope.json', body.length) !==
      createHash('sha256').update(body).digest('hex')
    )
      throw Error('invalid_coding_apply_scope');
    const path = join(leafPath, 'files');
    files = child(leaf, 'files', path, opened.created).fd;
    fs.fsyncSync(files);
    fs.fsyncSync(leaf);
    checkAssetPath(leaf, leafPath);
    checkAssetPath(commonFd, common);
    return path;
  } finally {
    if (files !== undefined) fs.closeSync(files);
    if (leaf !== undefined) fs.closeSync(leaf);
    if (parent !== undefined) fs.closeSync(parent);
    fs.closeSync(commonFd);
  }
}
