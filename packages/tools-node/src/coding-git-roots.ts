import { unsupportedGitStorage } from './coding-git-storage.js';
/** Index metadata only, including sparse trees, stages and resolve-undo roots. */
export function codingGitRoots(
  baseCommit: string,
  hasIndex: boolean,
  git: (args: string[], input?: string, maxBuffer?: number) => Buffer,
): ReadonlyMap<string, 'commit' | 'tree' | 'blob'> {
  const roots = new Map<string, 'commit' | 'tree' | 'blob'>([[baseCommit, 'commit']]);
  let entryCount = 0;
  for (const args of hasIndex ? [['--stage', '--sparse'], ['--resolve-undo']] : []) {
    const records = git(['ls-files', ...args, '-z'], undefined, 16777216)
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    entryCount += records.length;
    if (entryCount > 100000) return unsupportedGitStorage();
    for (const record of records) {
      const header = /^(100644|100755|120000|040000) ([a-f0-9]+) [0-3]\t/.exec(record);
      if (!header || header[2]!.length !== baseCommit.length) return unsupportedGitStorage();
      const oid = header[2]!,
        type = header[1] === '040000' ? 'tree' : 'blob';
      if (/^0+$/.test(oid)) continue;
      if (roots.has(oid) && roots.get(oid) !== type) return unsupportedGitStorage();
      roots.set(oid, type);
    }
  }
  return roots;
}
