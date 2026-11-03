import { desktopAssetPolicy } from './desktop-asset-policy.js';
import type { BigIntStats } from 'node:fs';
export type CodingAssetPolicy =
  | 'desktop'
  | 'coding-dependency'
  | 'all'
  | 'coding-worktree'
  | 'coding-recovery'
  | 'coding-recovery-v2'
  | 'classified-legacy';
export function checkAssetPolicy(
  policy: CodingAssetPolicy,
  relative: string,
  before: BigIntStats,
  publicationCandidate = false,
): void {
  if (policy === 'desktop') return desktopAssetPolicy(relative, before, publicationCandidate);
  if ((policy === 'coding-worktree' || policy === 'coding-dependency') && relative) {
    const parts = relative.split('/');
    if (
      parts.some(
        (part) =>
          [
            '.ssh',
            '.aws',
            '.config',
            '.npmrc',
            '.netrc',
            '.gitconfig',
            '.git-credentials',
            '.gnupg',
            '.kube',
          ].includes(part) ||
          /^\.env(?:\.|$)/i.test(part) ||
          /\.(?:pem|key|p12|pfx)$/i.test(part) ||
          /^id_(?:rsa|ed25519|ecdsa|dsa)/.test(part),
      ) ||
      (parts.includes('.git') && (relative !== '.git' || !before.isFile()))
    )
      throw Error('protected_coding_asset');
  }

  if (
    policy === 'classified-legacy' &&
    relative === '' &&
    (!before.isDirectory() || (before.mode & 0o7077n) !== 0n)
  )
    throw Error('protected_coding_asset');
  const scoped = policy === 'coding-recovery-v2';
  if (scoped && (relative === '' || relative === 'files')) {
    if (!before.isDirectory() || (before.mode & 0o077n) !== 0n)
      throw Error('protected_coding_asset');
    return;
  }
  if (scoped && relative === 'scope.json') {
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > 65536n ||
      (before.mode & 0o077n) !== 0n
    )
      throw Error('protected_coding_asset');
    return;
  }
  if (!relative || (policy !== 'coding-recovery' && policy !== 'classified-legacy' && !scoped))
    return;
  if (scoped && !relative.startsWith('files/')) throw Error('protected_coding_asset');
  const name = scoped ? relative.slice('files/'.length) : relative;
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.(?:before|after|json(?:\.next)?)$/.test(name) ||
    !before.isFile() ||
    (scoped &&
      before.nlink !== 1n &&
      !(publicationCandidate && name.endsWith('.after') && before.nlink === 2n)) ||
    (name.includes('.json') && (before.nlink !== 1n || before.size > 2097152n))
  )
    throw Error('protected_coding_asset');
}
