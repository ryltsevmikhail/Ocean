import type { BigIntStats } from 'node:fs';
import type { CodingAssetEntry } from '@runnets/domain';
const uuid = '[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}';
const asset = new RegExp('^(?:' + uuid + '|\\.upload-[a-zA-Z0-9_-]{1,80})$');
const receipt = new RegExp('^' + uuid + '\\.json(?:\\.' + uuid + '\\.tmp)?$');
function check(
  path: string,
  dir: boolean,
  file: boolean,
  mode: number,
  size: number,
  links: number,
  candidate = false,
): void {
  const parts = path.split('/');
  const valid =
    path === ''
      ? dir
      : parts.length === 1
        ? dir && /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(parts[0]!)
        : parts.length === 2
          ? dir
            ? asset.test(parts[1]!)
            : receipt.test(parts[1]!)
          : parts.length === 3 &&
            asset.test(parts[1]!) &&
            ['blob', 'metadata.json'].includes(parts[2]!) &&
            !dir;
  if (
    !valid ||
    mode !== (dir ? 0o700 : 0o600) ||
    (!dir &&
      (!file ||
        (links !== 1 && !(candidate && links === 2 && parts.length === 2)) ||
        size > (parts[2] === 'blob' ? 10485760 : 131072)))
  )
    throw Error('protected_desktop_asset');
}
/** Full namespace and private mode checks run in the metadata-only traversal. */
export function desktopAssetPolicy(path: string, s: BigIntStats, candidate = false): void {
  check(
    path,
    s.isDirectory(),
    s.isFile(),
    Number(s.mode & 0o777n),
    Number(s.size),
    Number(s.nlink),
    candidate,
  );
}
export function desktopManifestPolicy(entries: readonly CodingAssetEntry[]): void {
  for (const e of entries) {
    const target = e.kind === 'hardlink' ? entries.find((t) => t.path === e.target) : e;
    check(
      e.path,
      e.kind === 'directory',
      e.kind === 'file' || (e.kind === 'hardlink' && target?.kind === 'file'),
      target && 'mode' in target ? target.mode : 0,
      e.kind === 'file' ? e.bytes : 0,
      e.kind === 'hardlink' ? 2 : 1,
      e.kind === 'hardlink',
    );
  }
}
