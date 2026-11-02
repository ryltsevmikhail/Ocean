import { validateCodingAssetManifest } from './coding-asset-validation.js';
export interface CodingAssetLinkResolution {
  readonly path: string;
  readonly target: string;
}
const unavailable = (): never => {
  throw Error('coding_asset_links_unavailable');
};
/** Internal closure only. Never opens a recorded target or authorizes external graph traversal. */
export function validateCodingAssetLinks(value: unknown): readonly CodingAssetLinkResolution[] {
  const manifest = validateCodingAssetManifest(value),
    entries = new Map(manifest.entries.map((entry) => [entry.path, entry] as const)),
    resolutions: CodingAssetLinkResolution[] = [];
  let steps = 0;
  for (const entry of manifest.entries) {
    if (entry.kind !== 'symlink') continue;
    const current: string[] = [];
    let pending = entry.path.split('/'),
      hops = 0,
      cursor = 0;
    while (cursor < pending.length) {
      if (++steps > 1000000) return unavailable();
      // The preceding component must name a directory, including before dot/dotdot.
      if (entries.get(current.join('/'))?.kind !== 'directory') return unavailable();
      const part = pending[cursor++]!;
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (!current.length) return unavailable();
        current.pop();
        continue;
      }
      const path = [...current, part].join('/'),
        next = entries.get(path);
      if (!next) return unavailable();
      if (next.kind === 'symlink') {
        if (++hops > 40 || next.target.startsWith('/')) return unavailable();
        pending = [...next.target.split('/'), ...pending.slice(cursor)];
        cursor = 0;
        if (pending.length > 8192) return unavailable();
      } else current.push(part);
    }
    resolutions.push({ path: entry.path, target: current.join('/') });
  }
  return resolutions;
}
