import * as fs from 'node:fs';
import { join } from 'node:path';
import { desktopRoom, type DesktopBinding } from '@runnets/domain';
import { privateAssetChild, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import { withDesktopRoot } from './desktop-root.js';
/** Writes stay descriptor-relative even if the selected path is replaced; publication rechecks both paths. */
export function withDesktopRoom<T>(
  binding: DesktopBinding,
  room: string,
  consume: (path: string, verify: () => void) => T,
): T {
  if (!desktopRoom(room)) throw Error('desktop_binding_mismatch');
  return withDesktopRoot(
    binding,
    (root) => {
      root.verify();
      const path = join(root.path, room),
        canonical = join(binding.root, room);
      if (!fs.existsSync(path)) fs.mkdirSync(path, { mode: 0o700 });
      root.verify(true);
      const fd = privateAssetChild(root.fd, room, canonical);
      try {
        const initial = fs.fstatSync(fd, { bigint: true });
        const verify = () => {
          root.verify(true);
          checkAssetPath(fd, canonical);
          const current = fs.fstatSync(fd, { bigint: true });
          if (
            current.dev !== initial.dev ||
            current.ino !== initial.ino ||
            current.uid !== initial.uid ||
            current.gid !== initial.gid ||
            current.mode !== initial.mode ||
            codingAssetMount(fd) !== root.mount ||
            codingAssetIdentity(current) !==
              codingAssetIdentity(fs.lstatSync(path, { bigint: true }))
          )
            throw Error('desktop_binding_mismatch');
          const live = privateAssetChild(root.fd, room, canonical);
          try {
            if (
              codingAssetMount(live) !== root.mount ||
              codingAssetIdentity(fs.fstatSync(live, { bigint: true })) !==
                codingAssetIdentity(current)
            )
              throw Error('desktop_binding_mismatch');
          } finally {
            fs.closeSync(live);
          }
        };
        verify();
        const result = consume(assetFdPath(fd), verify);
        verify();
        fs.fsyncSync(fd);
        fs.fsyncSync(root.fd);
        return result;
      } finally {
        fs.closeSync(fd);
      }
    },
    true,
  );
}
