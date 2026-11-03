import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetDirectoryFlags, assetFdPath, assetNames, checkAssetPath } from './coding-asset-io.js';
import { invalidGitPack } from './coding-git-pack-bounds.js';
export type PrivateGit = (args: string[], input?: string | Buffer, maxBuffer?: number) => Buffer;
/** New synthetic bare repository only; no original pointers, source storage or ambient config. */
export function withPrivateGit<T>(
  format: 'sha1' | 'sha256',
  index: Buffer | null,
  consume: (git: PrivateGit) => T,
): T {
  const path = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'ocean-git-verify-'));
  const root = fs.openSync(path, assetDirectoryFlags),
    files: string[] = [];
  let objects: number | undefined, packs: number | undefined, indexFd: number | undefined;
  let refs = false,
    objectsCreated = false,
    packsCreated = false;
  const check = () => {
    checkAssetPath(root, path);
    if (objects !== undefined) checkAssetPath(objects, join(path, 'objects'));
    if (packs !== undefined) checkAssetPath(packs, join(path, 'objects/pack'));
  };
  try {
    fs.fchmodSync(root, 0o700);
    check();
    const write = (name: string, body: string | Buffer) => {
      fs.writeFileSync(join(assetFdPath(root), name), body, { mode: 0o600, flag: 'wx' });
      files.push(name);
    };
    write(
      'config',
      `[core]\nrepositoryformatversion = ${format === 'sha1' ? 0 : 1}\nbare = true\n${format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`,
    );
    write('HEAD', 'ref: refs/heads/unused\n');
    fs.mkdirSync(join(assetFdPath(root), 'refs'), { mode: 0o700 });
    refs = true;
    fs.mkdirSync(join(assetFdPath(root), 'objects'), { mode: 0o700 });
    objectsCreated = true;
    objects = fs.openSync(join(assetFdPath(root), 'objects'), assetDirectoryFlags);
    fs.mkdirSync(join(assetFdPath(objects), 'pack'), { mode: 0o700 });
    packsCreated = true;
    packs = fs.openSync(join(assetFdPath(objects), 'pack'), assetDirectoryFlags);
    if (index !== null) {
      if (index.length > 16777216) return invalidGitPack();
      write('index', index);
      indexFd = fs.openSync(
        join(assetFdPath(root), 'index'),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    }
    const git: PrivateGit = (args, input, maxBuffer = 10485760) => {
      check();
      let result: Buffer;
      try {
        result = execFileSync(
          '/usr/bin/git',
          [
            '--no-pager',
            '--git-dir=/proc/self/fd/3',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'gc.auto=0',
            '-c',
            'maintenance.auto=false',
            ...args,
          ],
          {
            input,
            encoding: null,
            timeout: 60000,
            maxBuffer,
            stdio: ['pipe', 'pipe', 'pipe', root, objects!, indexFd ?? 'ignore'],
            env: {
              PATH: '/usr/bin',
              HOME: '/nonexistent',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_NO_LAZY_FETCH: '1',
              GIT_NO_REPLACE_OBJECTS: '1',
              GIT_OPTIONAL_LOCKS: '0',
              GIT_TERMINAL_PROMPT: '0',
              GIT_OBJECT_DIRECTORY: '/proc/self/fd/4',
              GIT_INDEX_FILE: '/proc/self/fd/5',
            },
          },
        );
      } catch {
        return invalidGitPack();
      }
      check();
      return result;
    };
    return consume(git);
  } finally {
    try {
      check();
      if (packs !== undefined)
        for (const name of assetNames(packs, 8)) {
          if (!/^(?:pack-[a-f0-9]+\.(?:pack|idx|rev)|tmp_pack_[A-Za-z0-9_]+)$/.test(name))
            invalidGitPack();
          const target = join(assetFdPath(packs), name),
            stat = fs.lstatSync(target);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
            invalidGitPack();
          fs.unlinkSync(target);
        }
      if (packsCreated) fs.rmdirSync(join(assetFdPath(objects!), 'pack'));
      if (objectsCreated) fs.rmdirSync(join(assetFdPath(root), 'objects'));
      if (refs) fs.rmdirSync(join(assetFdPath(root), 'refs'));
      for (const name of files) fs.unlinkSync(join(assetFdPath(root), name));
      checkAssetPath(root, path);
      fs.rmdirSync(path);
    } finally {
      if (indexFd !== undefined) fs.closeSync(indexFd);
      if (packs !== undefined) fs.closeSync(packs);
      if (objects !== undefined) fs.closeSync(objects);
      fs.closeSync(root);
    }
  }
}
