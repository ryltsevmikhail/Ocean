import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { dirname, relative } from 'node:path';
import {
  codingAssetIdentity,
  codingAssetMount,
  type CodingAssetCapture,
} from './coding-asset-state.js';
import type { ProfileBackupBudget } from './profile-backup-session.js';
export interface ProfileArchiveContext {
  budget: ProfileBackupBudget;
  roots: readonly { capture: CodingAssetCapture; states: ReadonlyMap<string, string> }[];
}
export const profileArchiveContext = new AsyncLocalStorage<ProfileArchiveContext>();
/** Every archive reader is bound to the original wholegraph metadata, including intermediate parents. */
export function checkProfileArchiveFile(fd: number): void {
  const context = profileArchiveContext.getStore();
  if (!context) return;
  const path = fs.realpathSync('/proc/self/fd/' + fd);
  for (const { capture, states } of context.roots) {
    const root = fs.openSync(capture.root, 0x200000 | fs.constants.O_NOFOLLOW);
    try {
      if (
        codingAssetIdentity(fs.fstatSync(root, { bigint: true })) !== states.get('') ||
        codingAssetMount(root) !== capture.sourceMount ||
        fs.realpathSync('/proc/self/fd/' + root) !== capture.root
      )
        throw Error('stale_coding_asset');
    } finally {
      fs.closeSync(root);
    }
    if (path !== capture.root && !path.startsWith(capture.root + '/')) continue;
    if (
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !==
        states.get(relative(capture.root, path)) ||
      codingAssetMount(fd) !== capture.sourceMount
    )
      throw Error('stale_coding_asset');
    let currentPath = path;
    while (true) {
      const current = fs.openSync(currentPath, 0x200000 | fs.constants.O_NOFOLLOW);
      try {
        if (
          codingAssetIdentity(fs.fstatSync(current, { bigint: true })) !==
            states.get(relative(capture.root, currentPath)) ||
          codingAssetMount(current) !== capture.sourceMount ||
          fs.realpathSync('/proc/self/fd/' + current) !== currentPath
        )
          throw Error('stale_coding_asset');
      } finally {
        fs.closeSync(current);
      }
      if (currentPath === capture.root) break;
      currentPath = dirname(currentPath);
    }
  }
}
