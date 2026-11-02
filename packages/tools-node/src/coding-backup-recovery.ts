import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  captureCodingAssetTree,
  codingAssetIdentity,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { assetFdPath, checkAssetPath, privateAssetDirectory } from './coding-asset-io.js';
import { decodeCodingRecoveryIntent, invalidRecovery } from './coding-recovery-record.js';
export interface CodingApplyRecoveryCapture {
  readonly capture: CodingAssetCapture;
  readonly records: readonly {
    readonly id: string;
    readonly root: string;
    readonly path: string;
    readonly status: 'started' | 'completed';
    readonly nextOpaque: boolean;
  }[];
}
/** A selected, scoped recovery directory only; record status never settles a runtime receipt. */
export function captureCodingApplyRecovery(
  directory: string,
  projectRoots: readonly string[],
): CodingApplyRecoveryCapture {
  if (
    !projectRoots.length ||
    projectRoots.length > 1000 ||
    projectRoots.some(
      (root) =>
        typeof root !== 'string' ||
        root.length > 4096 ||
        root.includes('\0') ||
        resolve(root) !== root,
    )
  )
    return invalidRecovery();
  const projects = new Set(projectRoots),
    root = privateAssetDirectory(directory);
  try {
    const capture = captureCodingAssetTree(directory, {}, 'coding-recovery');
    const states = new Map(capture.sourceEntries),
      entries = new Map(capture.manifest.entries.map((entry) => [entry.path, entry]));
    const read = (name: string): Buffer => {
      const entry = entries.get(name);
      if (entry?.kind !== 'file' || entry.bytes > 2097152) return invalidRecovery();
      const fd = fs.openSync(
        join(assetFdPath(root), name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        if (codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== states.get(name))
          throw Error('stale_coding_asset');
        const buffer = Buffer.alloc(entry.bytes);
        let offset = 0;
        while (offset < buffer.length) {
          const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
          if (!count) throw Error('stale_coding_asset');
          offset += count;
        }
        if (
          codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== states.get(name) ||
          createHash('sha256').update(buffer).digest('hex') !== entry.sha256
        )
          throw Error('stale_coding_asset');
        checkAssetPath(fd, join(directory, name));
        return buffer;
      } finally {
        fs.closeSync(fd);
      }
    };
    const parse = (buffer: Buffer): unknown =>
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown;
    const records: CodingApplyRecoveryCapture['records'][number][] = [];
    for (const entry of capture.manifest.entries) {
      if (!entry.path.endsWith('.json')) continue;
      const id = entry.path.slice(0, -5);
      let intent: ReturnType<typeof decodeCodingRecoveryIntent>;
      try {
        intent = decodeCodingRecoveryIntent(parse(read(entry.path)), id, projects);
      } catch (error) {
        if (error instanceof Error && error.message === 'stale_coding_asset') throw error;
        return invalidRecovery();
      }
      if (intent.status === 'completed' && intent.before && !entries.has(intent.backup))
        return invalidRecovery();
      let nextOpaque = false;
      if (entries.has(entry.path + '.next')) {
        let next: unknown;
        try {
          next = parse(read(entry.path + '.next'));
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof TypeError) nextOpaque = true;
          else throw error;
        }
        if (!nextOpaque) {
          const decoded = decodeCodingRecoveryIntent(next, id, projects);
          if (
            JSON.stringify({ ...decoded, status: 'started' }) !==
            JSON.stringify({ ...intent, status: 'started' })
          )
            return invalidRecovery();
        }
      }
      records.push({ id, root: intent.root, path: intent.path, status: intent.status, nextOpaque });
    }
    const ids = new Set(records.map((record) => record.id));
    if (capture.manifest.entries.some((entry) => entry.path && !ids.has(entry.path.split('.')[0]!)))
      return invalidRecovery();
    const after = captureCodingAssetTree(directory, capture.limits, 'coding-recovery');
    if (
      after.sourceStateHash !== capture.sourceStateHash ||
      after.manifest.hash !== capture.manifest.hash
    )
      throw Error('stale_coding_asset');
    checkAssetPath(root, directory);
    return { capture, records };
  } finally {
    fs.closeSync(root);
  }
}
