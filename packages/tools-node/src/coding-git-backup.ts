import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { WorktreeBinding } from '@runnets/domain';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import {
  gitObjectStorage,
  readGitFile,
  readGitDescriptor,
  readGitBranch,
  unsupportedGitStorage,
} from './coding-git-storage.js';
export interface CodingGitObjectCapture {
  readonly format: 1;
  readonly baseCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly objectIds: readonly string[];
  readonly index: Buffer;
  readonly indexSha256: string;
  readonly pack: Buffer;
  readonly packSha256: string;
}
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
/** Trusted local Git reads from pinned objects/index under a synthesized config, never source config. */
export function captureCodingGitObjects(binding: WorktreeBinding): CodingGitObjectCapture {
  const { root, gitCommonDir: common, baseCommit, branch } = binding;
  if (
    process.platform !== 'linux' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit) ||
    !/^codex\/ocean\/[a-f0-9]{64}$/.test(branch) ||
    fs.realpathSync(root) !== root ||
    fs.realpathSync(common) !== common
  )
    return unsupportedGitStorage();
  const rootFd = fs.openSync(root, assetDirectoryFlags);
  let commonFd: number | undefined,
    admin: number | undefined,
    objects: number | undefined,
    indexFd: number | undefined;
  let scratch: string | undefined, scratchFd: number | undefined;
  const scratchEntries: string[] = [];
  let scratchRefs = false;
  try {
    commonFd = fs.openSync(common, assetDirectoryFlags);
    checkAssetPath(rootFd, root);
    checkAssetPath(commonFd, common);
    const pointer = readGitFile(rootFd, '.git', 4096).toString('utf8');
    if (!pointer.startsWith('gitdir: ') || !pointer.endsWith('\n')) return unsupportedGitStorage();
    const adminPath = resolve(root, pointer.slice(8, -1));
    if (
      dirname(adminPath) !== join(common, 'worktrees') ||
      fs.realpathSync(adminPath) !== adminPath
    )
      return unsupportedGitStorage();
    admin = fs.openSync(adminPath, assetDirectoryFlags);
    if (
      readGitFile(admin, 'HEAD', 256).toString() !== 'ref: refs/heads/' + branch + '\n' ||
      resolve(adminPath, readGitFile(admin, 'commondir', 4096).toString().trim()) !== common ||
      readGitFile(admin, 'gitdir', 4096).toString().trim() !== join(root, '.git') ||
      readGitBranch(commonFd, common, branch) !== baseCommit
    )
      return unsupportedGitStorage();
    objects = fs.openSync(join(assetFdPath(commonFd), 'objects'), assetDirectoryFlags);
    const objectPath = join(common, 'objects'),
      before = gitObjectStorage(objects, objectPath, baseCommit.length);
    const index = readGitFile(admin, 'index', 16777216);
    indexFd = fs.openSync(
      join(assetFdPath(admin), 'index'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    // The inherited descriptor must still identify the exact saved index bytes.
    if (
      !readGitDescriptor(indexFd, 16777216).equals(index) ||
      !readGitFile(admin, 'index', 16777216).equals(index)
    )
      throw Error('stale_coding_git_storage');
    scratch = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'ocean-git-pack-'));
    scratchFd = fs.openSync(scratch, assetDirectoryFlags);
    fs.fchmodSync(scratchFd, 0o700);
    checkAssetPath(scratchFd, scratch);
    const objectFormat = baseCommit.length === 40 ? 'sha1' : 'sha256';
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
            stdio: ['pipe', 'pipe', 'pipe', indexFd!, objects!, scratchFd!],
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
    const roots = new Set([baseCommit]);
    let entryCount = 0;
    for (const args of [['--stage', '--sparse'], ['--resolve-undo']]) {
      const output = git(['ls-files', ...args, '-z'], undefined, 16777216);
      const records = output.toString('utf8').split('\0').filter(Boolean);
      entryCount += records.length;
      if (entryCount > 100000) return unsupportedGitStorage();
      for (const record of records) {
        const header = /^(100644|100755|120000|040000) ([a-f0-9]+) [0-3]\t/.exec(record);
        if (!header || header[2]!.length !== baseCommit.length) return unsupportedGitStorage();
        if (!/^0+$/.test(header[2]!)) roots.add(header[2]!);
      }
    }
    const input = [...roots].join('\n') + '\n';
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
    if (
      !readGitDescriptor(indexFd, 16777216).equals(index) ||
      !readGitFile(admin, 'index', 16777216).equals(index) ||
      before !== gitObjectStorage(objects, objectPath, baseCommit.length) ||
      readGitFile(rootFd, '.git', 4096).toString() !== pointer ||
      readGitFile(admin, 'HEAD', 256).toString() !== 'ref: refs/heads/' + branch + '\n' ||
      resolve(adminPath, readGitFile(admin, 'commondir', 4096).toString().trim()) !== common ||
      readGitFile(admin, 'gitdir', 4096).toString().trim() !== join(root, '.git') ||
      readGitBranch(commonFd, common, branch) !== baseCommit
    )
      throw Error('stale_coding_git_storage');
    checkAssetPath(rootFd, root);
    checkAssetPath(commonFd, common);
    checkAssetPath(admin, adminPath);
    return {
      format: 1,
      baseCommit,
      objectFormat,
      objectIds: objectIds.sort(),
      index,
      indexSha256: digest(index),
      pack,
      packSha256: digest(pack),
    };
  } finally {
    if (indexFd !== undefined) fs.closeSync(indexFd);
    if (objects !== undefined) fs.closeSync(objects);
    if (admin !== undefined) fs.closeSync(admin);
    fs.closeSync(rootFd);
    if (commonFd !== undefined) fs.closeSync(commonFd);
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
