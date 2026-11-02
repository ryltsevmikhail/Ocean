import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import type { CodingAssetEntry } from '@runnets/domain';
import { assetFdPath, checkAssetPath } from './coding-asset-io.js';
import {
  hashAssetBytes,
  codingAssetIdentity,
  codingAssetMount,
  type PublicationGuard,
} from './coding-asset-state.js';
import { observeRecoverySource } from './coding-backup-scope-source.js';
import { readRecoveryJsonBytes } from './coding-recovery-evidence.js';
import { withPublicationTarget } from './coding-publication-project.js';

export interface BoundJson {
  entry: Extract<CodingAssetEntry, { kind: 'file' }>;
  state: string;
}
interface PublicationSource {
  common: string;
  slot: string;
  project: string;
  witness: string;
  mount: string;
  target: string;
  id: string;
  stagedState: string;
  originalState: string | undefined;
  header: BoundJson;
  mains: readonly BoundJson[];
}
const stale = (): never => {
  throw Error('stale_coding_asset');
};
function checkName(
  parent: number,
  directory: string,
  name: string,
  state: string | undefined,
  mount: string,
) {
  const at = join(assetFdPath(parent), name);
  if (state === undefined) {
    if (fs.lstatSync(at, { throwIfNoEntry: false })) stale();
    return;
  }
  const fd = fs.openSync(at, 0x200000 | fs.constants.O_NOFOLLOW);
  try {
    if (
      codingAssetMount(fd) !== mount ||
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state
    )
      stale();
    checkAssetPath(fd, join(directory, name));
  } finally {
    fs.closeSync(fd);
  }
}
/** Retain only checked scalar identities and JSON digests. The portable capture never supplies a project read path. */
export function bindPublication(source: PublicationSource, initialStaged: number) {
  const { common, slot, project, target, id, mount, header, mains } = source;
  const observe = <T>(staged: number, read: (witness: string) => T) =>
    observeRecoverySource(common, slot, (current, binding) => {
      if (!current.leaf || !current.files || binding !== source.witness) return stale();
      const { leaf, files } = current;
      const checkJson = () => {
        readRecoveryJsonBytes(
          leaf.fd,
          leaf.path,
          'scope.json',
          header.entry,
          header.state,
          65536,
          true,
        );
        // Each classified main contributed to the unique receipt-path proof.
        for (const main of mains)
          readRecoveryJsonBytes(
            files.fd,
            files.path,
            basename(main.entry.path),
            main.entry,
            main.state,
            2097152,
            true,
          );
      };
      const checkPhase = () => {
        if (
          codingAssetIdentity(fs.fstatSync(files.fd, { bigint: true })) !== files.state ||
          codingAssetIdentity(fs.fstatSync(staged, { bigint: true })) !== source.stagedState ||
          codingAssetMount(staged) !== mount
        )
          stale();
        checkAssetPath(staged, join(files.path, id + '.after'));
        checkName(files.fd, files.path, id + '.json.next', undefined, mount);
        checkName(files.fd, files.path, id + '.before', source.originalState, mount);
        checkName(files.fd, files.path, id + '.after', source.stagedState, mount);
      };
      checkJson();
      checkPhase();
      return withPublicationTarget(project, target, staged, mount, (witness, recheckTarget) => {
        checkJson();
        recheckTarget();
        checkPhase();
        const value = read(witness);
        checkJson();
        checkPhase();
        return value;
      });
    });
  const witness = observe(initialStaged, (value) => value);
  const guard: PublicationGuard = {
    read: (staged, read) =>
      observe(staged, (current) => {
        if (current !== witness) return stale();
        return read();
      }),
    verify: (hash, bytes, buffer) =>
      observeRecoverySource(common, slot, (current, binding) => {
        if (!current.files || binding !== source.witness) return stale();
        const fd = fs.openSync(
          join(assetFdPath(current.files.fd), id + '.after'),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          guard.read(fd, () => {
            if (hashAssetBytes(fd, bytes, buffer) !== hash) stale();
          });
        } finally {
          fs.closeSync(fd);
        }
      }),
  };
  return { witness, guard };
}
