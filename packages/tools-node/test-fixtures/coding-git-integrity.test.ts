import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { partialFixture } from './coding-partial.test.js';
import { captureCodingWorktreeAssets, archivePartialCodingGit } from '@runnets/tools-node';
export type IntegrityFixture = ReturnType<typeof partialFixture>;
export const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
export interface GitTestManifest {
  baseCommit: string;
  objectIds: string[];
  objectBytes: number;
  packBytes: number;
  packSha256: string;
}
export async function integrityArchive(f: IntegrityFixture) {
  const { hash: _old, ...oldBody } = f.inventory();
  const body = {
    ...oldBody,
    tasks: oldBody.tasks.map((task) => ({ ...task, baseCommit: f.worktree.baseCommit })),
  };
  const inventory = { ...body, hash: sha256(Buffer.from(JSON.stringify(body))) },
    archive = join(f.outer, 'archive');
  await captureCodingWorktreeAssets(
    inventory,
    f.managed,
    async () => {},
    async ({ git }) => {
      archivePartialCodingGit(git, archive);
    },
  );
  return archive;
}
export function rewritePack(
  f: IntegrityFixture,
  archive: string,
  ids: string[],
  delta?: 'ref' | 'offset',
) {
  const manifest = JSON.parse(
    fs.readFileSync(join(archive, 'manifest.json'), 'utf8'),
  ) as GitTestManifest;
  const pack = execFileSync(
    '/usr/bin/git',
    [
      '-C',
      f.project,
      'pack-objects',
      '--stdout',
      ...(delta
        ? ['--window=50', '--depth=50', ...(delta === 'offset' ? ['--delta-base-offset'] : [])]
        : ['--window=0', '--depth=0', '--no-reuse-object', '--no-reuse-delta']),
    ],
    { env: f.env, input: ids.join('\n') + '\n' },
  );
  Object.assign(manifest, {
    objectIds: [...ids].sort(),
    objectBytes: ids.reduce((sum, id) => sum + Number(f.git(f.project, 'cat-file', '-s', id)), 0),
    packBytes: pack.length,
    packSha256: sha256(pack),
  });
  fs.writeFileSync(join(archive, 'pack'), pack);
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(join(archive, 'manifest.json'), bytes);
  return { pack, hash: sha256(bytes), manifest };
}
export function indexRoots(f: IntegrityFixture) {
  const put = (text: string) =>
    execFileSync('/usr/bin/git', ['-C', f.root, 'hash-object', '-w', '--stdin'], {
      env: f.env,
      input: text,
      encoding: 'utf8',
    }).trim();
  const staged = put('staged only');
  f.git(f.root, 'update-index', '--add', '--cacheinfo', '100644,' + staged + ',stage-only');
  const conflicts = ['base conflict', 'ours conflict', 'theirs conflict'].map(put);
  execFileSync('/usr/bin/git', ['-C', f.root, 'update-index', '--index-info'], {
    env: f.env,
    input: conflicts.map((id, n) => `100644 ${id} ${n + 1}\tconflict\n`).join(''),
  });
  fs.writeFileSync(join(f.root, 'conflict'), 'resolved');
  f.git(f.root, 'add', 'conflict');
  return { staged, reuc: conflicts[2]! };
}
