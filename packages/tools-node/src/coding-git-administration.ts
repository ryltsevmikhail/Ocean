import { basename, join, resolve } from 'node:path';
import type { WorktreeBinding } from '@runnets/domain';
import { type GitEvidenceObserver, gitDigest } from './coding-git-observer.js';
import { unsupportedGitStorage } from './coding-git-storage.js';
import { codingAssetMount } from './coding-asset-state.js';
export interface CodingGitAdministration {
  readonly format: 1;
  readonly root: 'present' | 'absent';
  readonly branch: string | null;
  readonly admin: string | null;
  readonly files: readonly {
    readonly name: string;
    readonly body: string;
    readonly sha256: string;
  }[];
  readonly index: 'present' | 'absent';
  readonly hash: string;
}
function packedReferenceRows(bytes: Buffer, oidLength: number): string[] {
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text)) || !text.endsWith('\n')) return unsupportedGitStorage();
  const rows = text.slice(0, -1).split('\n'),
    names = new Set<string>();
  if (rows.length > 100000) return unsupportedGitStorage();
  let peelable = false;
  for (const [index, row] of rows.entries()) {
    if (index === 0 && /^# pack-refs with: [a-z -]+$/.test(row)) continue;
    if (peelable && new RegExp('^\\^[a-f0-9]{' + oidLength + '}$').test(row)) {
      peelable = false;
      continue;
    }
    const match = new RegExp('^[a-f0-9]{' + oidLength + '} (refs/[^\\x00-\\x20\\x7f]+)$').exec(row);
    if (!match || names.has(match[1]!)) return unsupportedGitStorage();
    names.add(match[1]!);
    peelable = true;
  }
  return rows;
}
/** Native worktree-add names only; arbitrary other worktree bodies/config/logs are never read. */
export function observeGitAdministration(
  binding: WorktreeBinding,
  observer: GitEvidenceObserver,
  managed: number | null,
) {
  const { root, gitCommonDir: common, branch, baseCommit } = binding;
  if (
    process.platform !== 'linux' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit) ||
    !/^codex\/ocean\/[a-f0-9]{64}$/.test(branch) ||
    basename(root) !== branch.slice(12)
  )
    return unsupportedGitStorage();
  const commonFd = observer.directory(common);
  if (commonFd === null) return unsupportedGitStorage();
  if (
    observer.child(commonFd, 'reftable') !== null ||
    observer.metadata(commonFd, 'packed-refs.lock', 16777216)
  )
    return unsupportedGitStorage();
  const objects = observer.child(commonFd, 'objects');
  if (objects === null) return unsupportedGitStorage();
  let refParent: number | null = commonFd;
  for (const part of ['refs', 'heads', 'codex', 'ocean']) {
    if (refParent === null) break;
    refParent = observer.child(refParent, part);
  }
  if (refParent !== null && observer.metadata(refParent, basename(root) + '.lock', 128))
    return unsupportedGitStorage();
  const loose = refParent === null ? null : observer.file(refParent, basename(root), 128);
  // Packed refs may coexist with a loose override; retain only the selected value, not other refs.
  const packed = observer.file(commonFd, 'packed-refs', 16777216);
  const packedRows = packed === null ? [] : packedReferenceRows(packed, baseCommit.length);
  let ref: string | null = loose?.toString() ?? null;
  if (ref === null && packed) {
    const rows = packedRows.filter((row) => row.endsWith(' refs/heads/' + branch));
    if (rows.length > 1) return unsupportedGitStorage();
    ref = rows[0]?.split(' ')[0] ?? null;
  }
  if (ref !== null && !new RegExp('^' + baseCommit + '\\n?$').test(ref))
    return unsupportedGitStorage();
  const rootFd = managed === null ? null : observer.child(managed, basename(root));
  const files: CodingGitAdministration['files'][number][] = [];
  const save = (name: string, bytes: Buffer) => {
    files.push({ name, body: bytes.toString('base64'), sha256: gitDigest(bytes) });
    return bytes.toString();
  };
  const pointer = rootFd === null ? null : observer.file(rootFd, '.git', 4096);
  if (rootFd !== null && pointer === null) return unsupportedGitStorage();
  const worktrees = observer.child(commonFd, 'worktrees');
  const candidates =
    worktrees === null
      ? []
      : observer
          .names(worktrees, 100000)
          .filter((name) => new RegExp('^' + basename(root) + '(?:[1-9][0-9]{0,8})?$').test(name));
  if (candidates.length > 1) return unsupportedGitStorage();
  const adminName = candidates[0] ?? null;
  const admin = adminName === null ? null : observer.child(worktrees!, adminName);
  if (adminName !== null && admin === null) throw Error('stale_coding_git_storage');
  if (
    pointer &&
    (!adminName ||
      save('root/.git', pointer) !== 'gitdir: ' + join(common, 'worktrees', adminName) + '\n')
  )
    return unsupportedGitStorage();
  let index: Buffer | null = null;
  if (admin !== null) {
    if (ref === null) return unsupportedGitStorage();
    const names = observer.names(admin, 16);
    if (
      names.some((name) => !['HEAD', 'commondir', 'gitdir', 'index', 'logs', 'refs'].includes(name))
    )
      return unsupportedGitStorage();
    const adminPath = join(common, 'worktrees', adminName!);
    for (const [name, max] of [
      ['HEAD', 256],
      ['commondir', 4096],
      ['gitdir', 4096],
    ] as const) {
      const bytes = observer.file(admin, name, max);
      if (!bytes) return unsupportedGitStorage();
      const value = save('admin/' + name, bytes);
      if (
        (name === 'HEAD' && value !== 'ref: refs/heads/' + branch + '\n') ||
        (name === 'commondir' &&
          (value !== '../..\n' || resolve(adminPath, value.trim()) !== common)) ||
        (name === 'gitdir' && value !== join(root, '.git') + '\n')
      )
        return unsupportedGitStorage();
    }
    // Reflog history is not required for object closure; validate its namespace without reading it.
    const refs = observer.child(admin, 'refs');
    if (refs !== null && observer.names(refs, 1).length) return unsupportedGitStorage();
    const logs = observer.child(admin, 'logs');
    if (logs !== null && observer.names(logs, 2).some((name) => name !== 'HEAD'))
      return unsupportedGitStorage();
    if (logs !== null) observer.metadata(logs, 'HEAD', 65536);
    index = observer.file(admin, 'index', 16777216);
  } else if (rootFd !== null) return unsupportedGitStorage();
  const body = {
    format: 1 as const,
    root: rootFd === null ? ('absent' as const) : ('present' as const),
    branch: ref === null ? null : baseCommit,
    admin: adminName,
    files,
    index: index === null ? ('absent' as const) : ('present' as const),
  };
  return {
    commonFd,
    objects,
    admin,
    index,
    rootFd,
    mount: codingAssetMount(commonFd),
    administration: { ...body, hash: gitDigest(JSON.stringify(body)) },
  };
}
