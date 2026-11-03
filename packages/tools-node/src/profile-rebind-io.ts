import * as fs from 'node:fs';
import { codingAssetMount } from './coding-asset-state.js';
export function rebindDirectoryIdentity(path: string): string {
  if (fs.realpathSync(path) !== path) throw Error('rebind_path_changed');
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const s = fs.fstatSync(fd, { bigint: true });
    if (s.uid !== BigInt(process.getuid!()) || s.mode & 0o7022n) throw Error('rebind_path_changed');
    return [s.dev, s.ino, s.uid, s.gid, s.mode, codingAssetMount(fd)].join(':');
  } finally {
    fs.closeSync(fd);
  }
}
export function rebindWrite(path: string, content: string): void {
  const fd = fs.openSync(path, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function rebindSync(path: string): void {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
