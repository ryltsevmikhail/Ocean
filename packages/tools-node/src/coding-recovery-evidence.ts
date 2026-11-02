import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingAssetEntry } from '@runnets/domain';
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
  readonly original: 'not-required' | 'absent' | 'matching' | 'conflict';
}
export const parseRecoveryJson = (buffer: Buffer): unknown =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;

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
  const records: CodingRecoveryRecordEvidence[] = [];
  for (const name of entries.keys()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const body = read(name);
    let value: unknown;
    try {
      value = parseRecoveryJson(body);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return invalidRecovery();
      throw error;
    }
    const intent = decodeCodingRecoveryIntent(value, id, projects),
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
        const matches =
          before.kind === 'file' &&
          before.sha256 === intent.before.sha256 &&
          (before.mode & 0o111 ? '100755' : '100644') === intent.before.mode;
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
    });
  }
  const ids = new Set(records.map((record) => record.id));
  if ([...entries.keys()].some((name) => !ids.has(name.split('.')[0]!))) return invalidRecovery();
  return records;
}
