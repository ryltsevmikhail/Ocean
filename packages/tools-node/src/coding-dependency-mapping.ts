import { posix } from 'node:path';
import type { CodingAssetEntry, CodingAssetManifest } from '@runnets/domain';
import { dependencyFail, dependencyHash } from './coding-dependency-config.js';
import { validateCodingAssetManifest } from './coding-asset-validation.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
export interface CodingDependencyMapping {
  readonly slot: string;
  readonly source: string;
  readonly target: string;
  readonly file: string | null;
  readonly manifestHash: string;
}
/** Build one inert virtual sandbox. No source path lookup and no link text rewriting. */
export function dependencyVirtualTree(
  mappings: readonly CodingDependencyMapping[],
  manifests: ReadonlyMap<string, CodingAssetManifest>,
  tree?: CodingAssetManifest,
  metadataOnly = false,
): CodingAssetManifest {
  const checked = (manifest: CodingAssetManifest) => {
    if (!metadataOnly) return validateCodingAssetManifest(manifest);
    const { hash: _hash, ...body } = manifest;
    const adjusted = {
      ...body,
      entries: body.entries.map((e) =>
        e.kind === 'file' ? { ...e, sha256: dependencyHash([e.path, e.bytes, e.mode]) } : e,
      ),
    };
    return validateCodingAssetManifest({ ...adjusted, hash: dependencyHash(adjusted) });
  };
  const entries = new Map<string, CodingAssetEntry>([
    ['', { path: '', kind: 'directory', mode: 0o700 }],
  ]);
  const parent = (path: string) => {
    const parts = path.split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      const prior = entries.get(current);
      if (prior && prior.kind !== 'directory') return dependencyFail();
      if (!prior) entries.set(current, { path: current, kind: 'directory', mode: 0o755 });
    }
  };
  const add = (prefix: string, manifest: CodingAssetManifest, file: string | null) => {
    for (const entry of manifest.entries) {
      if (file !== null && entry.path !== file) continue;
      const path = file === null ? posix.join(prefix, entry.path) : prefix;
      parent(path);
      if (entries.has(path)) return dependencyFail();
      entries.set(
        path,
        entry.kind === 'hardlink'
          ? { ...entry, path, target: posix.join(prefix, entry.target) }
          : { ...entry, path },
      );
    }
  };
  if (tree) add('workspace', checked(tree), null);
  else entries.set('workspace', { path: 'workspace', kind: 'directory', mode: 0o700 });
  for (const mapping of mappings) {
    const manifest = manifests.get(mapping.slot);
    if (!manifest || manifest.hash !== mapping.manifestHash) return dependencyFail();
    const target = mapping.target.slice(1),
      previous = entries.get(target);
    // Runtime creates empty mountpoint directories. Only those can be covered.
    if (previous) {
      if (
        previous.kind !== 'directory' ||
        [...entries.keys()].some((p) => p.startsWith(target + '/'))
      )
        return dependencyFail();
      entries.delete(target);
    }
    add(target, checked(manifest), mapping.file);
  }
  const ordered = [...entries.values()].sort((a, b) => {
    const left = a.path.split('/'),
      right = b.path.split('/');
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const compared = Buffer.compare(Buffer.from(left[i]!), Buffer.from(right[i]!));
      if (compared) return compared;
    }
    return left.length - right.length;
  });
  const body = {
    format: 1 as const,
    entries: ordered,
    bytes: ordered.reduce((n, e) => n + (e.kind === 'file' ? e.bytes : 0), 0),
  };
  const result = validateCodingAssetManifest({ ...body, hash: dependencyHash(body) });
  validateCodingAssetLinks(result);
  return result;
}
