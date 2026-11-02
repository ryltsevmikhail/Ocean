import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { CodingArtifactError, type CodingFileMode } from '@runnets/domain';
import { codingPath } from './coding-git.js';
import { FILE_BYTES } from './coding-tree.js';
export interface CodingFile {
  readonly body: Buffer;
  readonly mode: CodingFileMode;
}
export async function codingFile(root: string, path: string): Promise<CodingFile | null> {
  codingPath(path);
  const parts = path.split('/');
  let full = root;
  try {
    for (const [index, part] of parts.entries()) {
      full = join(full, part);
      const s = await lstat(full);
      if (s.isSymbolicLink()) throw new CodingArtifactError('unsupported_file');
      if (index === parts.length - 1 && s.isDirectory()) return null;
      if (index < parts.length - 1 && !s.isDirectory()) {
        if (s.isFile() && s.nlink === 1) return null;
        throw new CodingArtifactError('unsupported_file');
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) throw new CodingArtifactError('unsupported_file');
    if (before.size > FILE_BYTES) throw new CodingArtifactError('changeset_limit');
    if ((await realpath('/proc/self/fd/' + String(file.fd))) !== full)
      throw new CodingArtifactError('unsupported_file');
    const buffer = Buffer.alloc(Math.min(before.size + 1, FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > FILE_BYTES) throw new CodingArtifactError('changeset_limit');
    const body = buffer.subarray(0, length),
      after = await file.stat();
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.mode !== after.mode ||
      body.length !== before.size
    )
      throw new CodingArtifactError('stale_capture');
    return { body, mode: before.mode & 0o111 ? '100755' : '100644' };
  } finally {
    await file.close();
  }
}
