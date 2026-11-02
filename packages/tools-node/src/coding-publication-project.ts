import * as fs from 'node:fs';
import { join } from 'node:path';
import { assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import { graphHash } from './coding-recovery-plan.js';
import { invalidRecovery } from './coding-recovery-record.js';

const pathFlags = 0x200000 | fs.constants.O_NOFOLLOW; // Linux O_PATH
/** Walk just the canonical destination. Keep the target metadata descriptor across the staged read. */
export function withPublicationTarget<T>(
  project: string,
  relative: string,
  staged: number,
  mount: string,
  read: (witness: string, recheck: () => void) => T,
): T {
  const target = join(project, relative);
  const state = codingAssetIdentity(fs.fstatSync(staged, { bigint: true }));
  const pin = () => {
    const chain = [];
    let fd = fs.openSync('/', pathFlags | fs.constants.O_DIRECTORY),
      canonical = '/';
    try {
      for (const part of target.slice(1).split('/')) {
        canonical = join(canonical, part);
        const next = fs.openSync(
          join(assetFdPath(fd), part),
          pathFlags | (canonical === target ? 0 : fs.constants.O_DIRECTORY),
        );
        fs.closeSync(fd);
        fd = next;
        const stat = fs.fstatSync(fd, { bigint: true }),
          observedMount = codingAssetMount(fd);
        if (
          (canonical === project || canonical.startsWith(project + '/')) &&
          observedMount !== mount
        )
          return invalidRecovery();
        if (
          canonical === target &&
          (!stat.isFile() || stat.nlink !== 2n || codingAssetIdentity(stat) !== state)
        )
          return invalidRecovery();
        chain.push([stat.dev.toString(), stat.ino.toString(), observedMount]);
      }
      checkAssetPath(fd, target);
      if (codingAssetMount(staged) !== mount) return invalidRecovery();
      return { fd, witness: graphHash(chain) };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  const first = pin();
  try {
    const recheck = () => {
      const last = pin();
      try {
        if (
          last.witness !== first.witness ||
          codingAssetIdentity(fs.fstatSync(first.fd, { bigint: true })) !== state
        )
          throw Error('stale_coding_asset');
      } finally {
        fs.closeSync(last.fd);
      }
    };
    const result = read(first.witness, recheck);
    recheck();
    return result;
  } finally {
    fs.closeSync(first.fd);
  }
}
