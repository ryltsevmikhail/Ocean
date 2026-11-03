import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CodingFileContent } from '@runnets/domain';
import { codingPath } from './coding-git.js';
import { blockedName } from './backend.js';
export interface CodingRecoveryIntent {
  readonly version: 1;
  readonly root: string;
  readonly path: string;
  readonly before: CodingFileContent | null;
  readonly after: CodingFileContent | null;
  readonly backup: string;
  readonly staged: string;
  readonly status: 'started' | 'completed';
}
export const invalidRecovery = (): never => {
  throw Error('invalid_coding_apply_recovery');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidRecovery();
  return value as Record<string, unknown>;
}
function content(value: unknown): CodingFileContent | null {
  if (value === null) return null;
  const c = object(value);
  if (
    Object.keys(c).some((key) => !['mode', 'text', 'sha256'].includes(key)) ||
    (c['mode'] !== '100644' && c['mode'] !== '100755') ||
    typeof c['text'] !== 'string' ||
    Buffer.byteLength(c['text']) > 131072 ||
    c['text'].includes('\0') ||
    Buffer.from(c['text']).toString('utf8') !== c['text'] ||
    createHash('sha256').update(c['text']).digest('hex') !== c['sha256']
  )
    return invalidRecovery();
  return {
    mode: c['mode'],
    text: c['text'],
    sha256: String(c['sha256']),
  };
}
export function decodeCodingRecoveryIntent(
  value: unknown,
  id: string,
  projects: ReadonlySet<string> | null,
): CodingRecoveryIntent {
  const r = object(value);
  if (
    Object.keys(r).some(
      (key) =>
        !['version', 'root', 'path', 'before', 'after', 'backup', 'staged', 'status'].includes(key),
    ) ||
    r['version'] !== 1 ||
    typeof r['root'] !== 'string' ||
    (projects !== null && !projects.has(r['root'])) ||
    !r['root'] ||
    Buffer.byteLength(r['root']) > 4096 ||
    r['root'].includes('\0') ||
    resolve(r['root']) !== r['root'] ||
    typeof r['path'] !== 'string' ||
    r['backup'] !== id + '.before' ||
    r['staged'] !== id + '.after' ||
    (r['status'] !== 'started' && r['status'] !== 'completed')
  )
    return invalidRecovery();
  try {
    codingPath(r['path']);
  } catch {
    return invalidRecovery();
  }
  if (r['path'].split('/').some(blockedName)) return invalidRecovery();
  const before = content(r['before']),
    after = content(r['after']);
  if (!before && !after) return invalidRecovery();
  return {
    version: 1,
    root: r['root'],
    path: r['path'],
    before,
    after,
    backup: String(r['backup']),
    staged: String(r['staged']),
    status: r['status'],
  };
}
