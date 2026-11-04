import * as fs from 'node:fs';
import { join } from 'node:path';
import { desktopRoom, desktopUuid } from '@runnets/domain';
import { privateAssetChild, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import type { holdDesktopRoot } from './desktop-root.js';
export function readDesktopPrivate(
  root: ReturnType<typeof holdDesktopRoot>,
  room: string,
  id: string | null,
  name: string,
  limit: number,
): Buffer {
  if (!desktopRoom(room) || (id !== null && !desktopUuid(id)))
    throw Error('desktop_binding_mismatch');
  const rootPath = fs.realpathSync(root.path),
    roomPath = join(rootPath, room);
  const roomFd = privateAssetChild(root.fd, room, roomPath);
  let parent = roomFd;
  try {
    if (codingAssetMount(roomFd) !== root.mount) throw Error('desktop_binding_mismatch');
    const parentPath = id === null ? roomPath : join(roomPath, id);
    if (id !== null) parent = privateAssetChild(roomFd, id, parentPath);
    if (codingAssetMount(parent) !== root.mount) throw Error('desktop_binding_mismatch');
    root.verify();
    const path = join(parentPath, name),
      at = join(assetFdPath(parent), name);
    const fd = fs.openSync(
      at,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const s = fs.fstatSync(fd, { bigint: true }),
        state = codingAssetIdentity(s);
      if (
        !s.isFile() ||
        s.nlink !== 1n ||
        s.uid !== BigInt(process.getuid!()) ||
        (s.mode & 0o777n) !== 0o600n ||
        s.size > BigInt(limit) ||
        codingAssetMount(fd) !== root.mount
      )
        throw Error('desktop_asset_corrupted');
      root.verify();
      checkAssetPath(parent, parentPath);
      checkAssetPath(fd, path);
      const data = Buffer.alloc(Number(s.size));
      let offset = 0;
      while (offset < data.length) {
        const n = fs.readSync(fd, data, offset, data.length - offset, offset);
        if (!n) throw Error('desktop_asset_corrupted');
        offset += n;
      }
      if (
        codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state ||
        codingAssetIdentity(fs.lstatSync(at, { bigint: true })) !== state ||
        codingAssetMount(fd) !== root.mount ||
        codingAssetMount(parent) !== root.mount ||
        codingAssetMount(roomFd) !== root.mount
      )
        throw Error('desktop_asset_corrupted');
      root.verify();
      checkAssetPath(roomFd, roomPath);
      checkAssetPath(parent, parentPath);
      checkAssetPath(fd, path);
      return data;
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    if (parent !== roomFd) fs.closeSync(parent);
    fs.closeSync(roomFd);
  }
}
