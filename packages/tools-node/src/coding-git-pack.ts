import { codingGitRoots } from './coding-git-roots.js';
import { verifyCodingGitPack } from './coding-git-verify.js';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { readGitDescriptor, unsupportedGitStorage } from './coding-git-storage.js';
/** Pack only explicit base/index roots through sterile local Git and inherited descriptors. */
export function packCodingGitObjects(baseCommit: string, objects: number, indexFd?: number) {
  const index = indexFd === undefined ? null : readGitDescriptor(indexFd, 16777216);
  let scratch: string | undefined, scratchFd: number | undefined;
  const scratchEntries: string[] = [];
  let scratchRefs = false;
  try {
    scratch = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'ocean-git-pack-'));
    scratchFd = fs.openSync(scratch, assetDirectoryFlags);
    fs.fchmodSync(scratchFd, 0o700);
    checkAssetPath(scratchFd, scratch);
    const objectFormat: 'sha1' | 'sha256' = baseCommit.length === 40 ? 'sha1' : 'sha256';
    fs.writeFileSync(
      join(assetFdPath(scratchFd), 'config'),
      `[core]\nrepositoryformatversion = ${objectFormat === 'sha1' ? 0 : 1}\nbare = true\n${objectFormat === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`,
      { mode: 0o600, flag: 'wx' },
    );
    scratchEntries.push('config');
    fs.writeFileSync(join(assetFdPath(scratchFd), 'HEAD'), 'ref: refs/heads/unused\n', {
      mode: 0o600,
    });
    scratchEntries.push('HEAD');
    fs.mkdirSync(join(assetFdPath(scratchFd), 'refs'), { mode: 0o700 });
    scratchRefs = true;
    const git = (args: string[], input?: string, maxBuffer = 268435456): Buffer => {
      try {
        return execFileSync(
          '/usr/bin/git',
          [
            '--no-pager',
            '--git-dir=/proc/self/fd/5',
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
            stdio: ['pipe', 'pipe', 'pipe', indexFd ?? 'ignore', objects, scratchFd!],
            env: {
              PATH: '/usr/bin',
              HOME: '/nonexistent',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_NO_LAZY_FETCH: '1',
              GIT_NO_REPLACE_OBJECTS: '1',
              GIT_OPTIONAL_LOCKS: '0',
              GIT_TERMINAL_PROMPT: '0',
              GIT_INDEX_FILE: '/proc/self/fd/3',
              GIT_OBJECT_DIRECTORY: '/proc/self/fd/4',
            },
          },
        );
      } catch {
        throw Error('coding_git_capture_failed');
      }
    };
    const roots = codingGitRoots(baseCommit, indexFd !== undefined, git);
    const input = [...roots.keys()].join('\n') + '\n';
    const objectIds = git(['rev-list', '--objects', '--no-object-names', '--stdin'], input, 6500065)
      .toString('ascii')
      .trim()
      .split('\n');
    if (
      objectIds.length > 100000 ||
      objectIds.some((id) => !new RegExp('^[a-f0-9]{' + baseCommit.length + '}$').test(id))
    )
      return unsupportedGitStorage();
    const sizes = git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      objectIds.join('\n') + '\n',
      10485760,
    )
      .toString('ascii')
      .trim()
      .split('\n');
    let bytes = 0;
    if (sizes.length !== objectIds.length) return unsupportedGitStorage();
    for (const [i, row] of sizes.entries()) {
      const fields = row.split(' '),
        size = Number(fields[2]);
      bytes += size;
      if (
        fields[0] !== objectIds[i] ||
        !['blob', 'tree', 'commit', 'tag'].includes(fields[1]!) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 67108864 ||
        bytes > 2147483648
      )
        return unsupportedGitStorage();
    }
    const pack = git(
      [
        'pack-objects',
        '--stdout',
        '--revs',
        '--threads=1',
        '--window=0',
        '--depth=0',
        '--no-reuse-delta',
        '--no-reuse-object',
      ],
      input,
    );
    if (
      pack.length < 12 ||
      pack.subarray(0, 4).toString('ascii') !== 'PACK' ||
      ![2, 3].includes(pack.readUInt32BE(4)) ||
      pack.readUInt32BE(8) !== objectIds.length ||
      new Set(objectIds).size !== objectIds.length
    )
      return unsupportedGitStorage();
    try {
      verifyCodingGitPack({ baseCommit, objectFormat, objectIds, objectBytes: bytes, pack }, index);
    } catch {
      throw Error('coding_git_capture_failed');
    }
    return {
      format: 1 as const,
      baseCommit,
      objectFormat,
      objectIds: objectIds.sort(),
      objectBytes: bytes,
      pack,
      packSha256: createHash('sha256').update(pack).digest('hex'),
    };
  } finally {
    if (scratchFd !== undefined) {
      try {
        checkAssetPath(scratchFd, scratch!);
        for (const name of scratchEntries) fs.unlinkSync(join(assetFdPath(scratchFd), name));
        if (scratchRefs) fs.rmdirSync(join(assetFdPath(scratchFd), 'refs'));
        checkAssetPath(scratchFd, scratch!);
        fs.rmdirSync(scratch!);
      } finally {
        fs.closeSync(scratchFd);
      }
    }
  }
}
