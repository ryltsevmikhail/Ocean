import { profileBackupSession } from './profile-backup-session.js';
import { retainProfileClassification } from './profile-backup-file.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingAssetEntry, CodingAssetManifest } from '@runnets/domain';
import {
  codingAssetIdentity,
  codingAssetMount,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { assetFdPath, checkAssetPath } from './coding-asset-io.js';
import {
  decodeCodingRecoveryIntent,
  invalidRecovery,
  type CodingRecoveryIntent,
} from './coding-recovery-record.js';

export interface CodingRecoveryRecordEvidence {
  readonly id: string;
  readonly root: string;
  readonly path: string;
  readonly status: 'started' | 'completed';
  readonly nextOpaque: boolean;
  readonly publicationLink?: 'matching' | 'conflict';
  readonly original: 'not-required' | 'absent' | 'matching' | 'conflict';
}
export const parseRecoveryJson = (buffer: Buffer): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;

export function decodeRecoveryMain(
  bytes: Buffer,
  id: string,
  projects: ReadonlySet<string> | null,
) {
  try {
    return decodeCodingRecoveryIntent(parseRecoveryJson(bytes), id, projects);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return invalidRecovery();
    throw error;
  }
}
/** Caller provides one preflighted basename and its checked parent FD. */
export function readRecoveryJsonBytes(
  parent: number,
  directory: string,
  name: string,
  entry: CodingAssetEntry | undefined,
  identity: string | undefined,
  limit: number,
  verifyDigest: boolean,
): Buffer {
  profileBackupSession.getStore()?.checkMetadata();
  if (entry?.kind !== 'file' || entry.bytes > limit) return invalidRecovery();
  const path = join(assetFdPath(parent), name);
  const file = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const check = () => {
      if (
        codingAssetMount(file) !== codingAssetMount(parent) ||
        codingAssetIdentity(fs.fstatSync(file, { bigint: true })) !== identity ||
        codingAssetIdentity(fs.lstatSync(path, { bigint: true })) !== identity
      )
        throw Error('stale_coding_asset');
      checkAssetPath(file, join(directory, name));
    };
    check();
    const buffer = Buffer.alloc(entry.bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(file, buffer, offset, buffer.length - offset, offset);
      if (!count) throw Error('stale_coding_asset');
      offset += count;
    }
    check();
    if (verifyDigest && createHash('sha256').update(buffer).digest('hex') !== entry.sha256)
      throw Error('stale_coding_asset');
    retainProfileClassification(file, join(directory, name), buffer);
    return buffer;
  } finally {
    fs.closeSync(file);
  }
}
export function readCodingRecoveryRecords(
  capture: CodingAssetCapture,
  parent: number,
  projects: ReadonlySet<string>,
  prefix: '' | 'files/',
  checkIntent?: (intent: CodingRecoveryIntent) => void,
  publications?: ReadonlySet<string>,
): CodingRecoveryRecordEvidence[] {
  const states = new Map(capture.sourceEntries);
  const entries = new Map(
    capture.manifest.entries
      .filter((e) => e.path.startsWith(prefix) && e.path !== prefix)
      .map((e) => [e.path.slice(prefix.length), e]),
  );
  const read = (name: string) =>
    readRecoveryJsonBytes(
      parent,
      join(capture.root, prefix),
      name,
      entries.get(name),
      states.get(prefix + name),
      2097152,
      true,
    );
  return decodeCodingRecoveryRecords(
    capture.manifest,
    projects,
    prefix,
    read,
    checkIntent,
    publications,
  );
}
/** Archive-only semantic decoder; the caller supplies bounded verified content by basename. */
export function decodeCodingRecoveryRecords(
  manifest: CodingAssetManifest,
  projects: ReadonlySet<string>,
  prefix: '' | 'files/',
  read: (name: string) => Buffer,
  checkIntent?: (intent: CodingRecoveryIntent) => void,
  publications?: ReadonlySet<string>,
): CodingRecoveryRecordEvidence[] {
  const entries = new Map(
    manifest.entries
      .filter((e) => e.path.startsWith(prefix) && e.path !== prefix)
      .map((e) => [e.path.slice(prefix.length), e]),
  );
  const records: CodingRecoveryRecordEvidence[] = [];
  for (const name of entries.keys()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const intent = decodeRecoveryMain(read(name), id, projects),
      before = entries.get(intent.backup);
    checkIntent?.(intent);
    if (intent.status === 'completed' && intent.before && !before) return invalidRecovery();
    if (
      prefix &&
      ((!intent.before && before) ||
        ((!intent.after || intent.status === 'completed') && entries.has(intent.staged)))
    )
      return invalidRecovery();
    let nextOpaque = false;
    if (entries.has(name + '.next')) {
      const nextBody = read(name + '.next');
      let next: unknown;
      try {
        next = parseRecoveryJson(nextBody);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) nextOpaque = true;
        else throw error;
      }
      if (!nextOpaque) {
        const decoded = decodeCodingRecoveryIntent(next, id, projects);
        if (
          prefix === 'files/' &&
          (intent.status !== 'started' ||
            decoded.status !== 'completed' ||
            entries.has(intent.staged) ||
            (intent.before && !before))
        )
          return invalidRecovery();
        if (
          JSON.stringify({ ...decoded, status: 'started' }) !==
          JSON.stringify({ ...intent, status: 'started' })
        )
          return invalidRecovery();
      }
    }
    let original: CodingRecoveryRecordEvidence['original'] = 'not-required';
    if (intent.before) {
      original = 'absent';
      if (before) {
        const matches = matchesContent(
          before.kind === 'hardlink'
            ? manifest.entries.find((e) => e.path === before.target)
            : before,
          intent.before,
        );
        original = matches ? 'matching' : 'conflict';
      }
    }
    records.push({
      id,
      root: intent.root,
      path: intent.path,
      status: intent.status,
      nextOpaque,
      original,
      ...(publications?.has(prefix + intent.staged) && {
        publicationLink: matchesContent(entries.get(intent.staged), intent.after)
          ? ('matching' as const)
          : ('conflict' as const),
      }),
    });
  }
  const ids = new Set(records.map((record) => record.id));
  if (
    [...entries.keys()].some(
      (name) =>
        !ids.has(name.split('.')[0]!) || !/^[^.]+\.(?:json(?:\.next)?|before|after)$/.test(name),
    )
  )
    return invalidRecovery();
  return records;
}

function matchesContent(
  entry: CodingAssetEntry | undefined,
  expected: CodingRecoveryIntent['after'],
) {
  return (
    entry?.kind === 'file' &&
    expected &&
    entry.sha256 === expected.sha256 &&
    (entry.mode & 0o111 ? '100755' : '100644') === expected.mode
  );
}
