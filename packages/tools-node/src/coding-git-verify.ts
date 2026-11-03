import type { CodingGitObjectCapture } from './coding-git-backup.js';
import { preflightGitPack, invalidGitPack } from './coding-git-pack-bounds.js';
import { withPrivateGit } from './coding-git-private.js';
import { codingGitRoots } from './coding-git-roots.js';
type PackEvidence = Pick<
  CodingGitObjectCapture,
  'baseCommit' | 'objectFormat' | 'objectIds' | 'objectBytes' | 'pack'
>;
/** Verify actual object identities and exact reachable closure without any source repository. */
export function verifyCodingGitPack(
  evidence: PackEvidence,
  index: Buffer | null,
  charge?: (bytes: number) => void,
): void {
  try {
    const { baseCommit, objectFormat, objectIds, objectBytes, pack } = evidence;
    const oid = new RegExp('^[a-f0-9]{' + (objectFormat === 'sha1' ? 40 : 64) + '}$');
    if (
      !['sha1', 'sha256'].includes(objectFormat) ||
      !oid.test(baseCommit) ||
      objectIds.length > 100000 ||
      objectIds.some((id) => !oid.test(id)) ||
      new Set(objectIds).size !== objectIds.length ||
      !objectIds.includes(baseCommit) ||
      preflightGitPack(pack, objectFormat, objectIds.length, 2147483648, charge) !== objectBytes
    )
      return invalidGitPack();
    withPrivateGit(objectFormat, index, (git) => {
      git(
        ['index-pack', '--stdin', '--strict', '--threads=1', '--max-input-size=268435456'],
        pack,
        4096,
      );
      const rows = git([
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ])
        .toString('ascii')
        .trim()
        .split('\n');
      const actual = new Map<string, string>();
      let bytes = 0;
      if (rows.length !== objectIds.length) return invalidGitPack();
      for (const row of rows) {
        const fields = row.split(' '),
          size = Number(fields[2]);
        if (
          fields.length !== 3 ||
          !oid.test(fields[0]!) ||
          !['blob', 'tree', 'commit', 'tag'].includes(fields[1]!) ||
          actual.has(fields[0]!) ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > 67108864
        )
          return invalidGitPack();
        actual.set(fields[0]!, fields[1]!);
        bytes += size;
      }
      const expected = JSON.stringify([...objectIds].sort());
      if (bytes !== objectBytes || JSON.stringify([...actual.keys()].sort()) !== expected)
        return invalidGitPack();
      const roots = codingGitRoots(baseCommit, index !== null, git);
      for (const [id, type] of roots) if (actual.get(id) !== type) return invalidGitPack();
      const closure = git(
        ['rev-list', '--objects', '--no-object-names', '--stdin'],
        [...roots.keys()].join('\n') + '\n',
        6500065,
      )
        .toString('ascii')
        .trim()
        .split('\n');
      if (
        closure.length !== objectIds.length ||
        new Set(closure).size !== closure.length ||
        JSON.stringify(closure.sort()) !== expected
      )
        return invalidGitPack();
    });
  } catch {
    invalidGitPack();
  }
}
