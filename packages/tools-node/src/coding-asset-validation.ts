import { createHash } from 'node:crypto';
import type { CodingAssetEntry, CodingAssetManifest } from '@runnets/domain';
import { CODING_ASSET_LIMITS } from './coding-asset-scan.js';
const fail = (): never => {
  throw Error('invalid_coding_asset_archive');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= 4096 &&
    Buffer.from(value).toString('utf8') === value
  );
}
export function validAssetPath(value: unknown): value is string {
  return (
    text(value) &&
    value !== '' &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every(
        (part) => part !== '' && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255,
      )
  );
}
/** Validates untrusted portable metadata before any archive path is used. Links remain inert. */
export function validateCodingAssetManifest(value: unknown): CodingAssetManifest {
  const raw = object(value);
  if (
    Object.keys(raw).some((key) => !['format', 'entries', 'bytes', 'hash'].includes(key)) ||
    raw['format'] !== 1 ||
    !Array.isArray(raw['entries']) ||
    raw['entries'].length === 0 ||
    raw['entries'].length > CODING_ASSET_LIMITS.entries ||
    !Number.isSafeInteger(raw['bytes']) ||
    Number(raw['bytes']) < 0 ||
    Number(raw['bytes']) > CODING_ASSET_LIMITS.bytes ||
    typeof raw['hash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw['hash'])
  )
    return fail();
  const entries: CodingAssetEntry[] = [],
    known = new Map<string, CodingAssetEntry['kind']>(),
    blobs = new Map<string, number>();
  let bytes = 0,
    metadata = 0;
  for (const [index, item] of raw['entries'].entries()) {
    const entry = object(item),
      path = entry['path'],
      kind = entry['kind'];
    if (
      !text(path) ||
      (index === 0 ? path !== '' || kind !== 'directory' : !validAssetPath(path)) ||
      known.has(path)
    )
      return fail();
    const parts = path.split('/');
    if (
      (path === '' ? 0 : parts.length) > CODING_ASSET_LIMITS.depth ||
      (index > 0 && known.get(parts.slice(0, -1).join('/')) !== 'directory')
    )
      return fail();
    let normalized: CodingAssetEntry;
    if (kind === 'file' || kind === 'directory') {
      const mode = entry['mode'];
      if (
        !Number.isSafeInteger(mode) ||
        Number(mode) < 0 ||
        Number(mode) > 0o777 ||
        Object.keys(entry).some(
          (key) =>
            !(
              kind === 'file'
                ? ['path', 'kind', 'mode', 'bytes', 'sha256']
                : ['path', 'kind', 'mode']
            ).includes(key),
        )
      )
        return fail();
      if (kind === 'directory') normalized = { path, kind, mode: Number(mode) };
      else {
        const length = entry['bytes'],
          sha256 = entry['sha256'];
        if (
          !Number.isSafeInteger(length) ||
          Number(length) < 0 ||
          typeof sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(sha256) ||
          (blobs.has(sha256) && blobs.get(sha256) !== length)
        )
          return fail();
        bytes += Number(length);
        if (bytes > CODING_ASSET_LIMITS.bytes) return fail();
        blobs.set(sha256, Number(length));
        normalized = { path, kind, mode: Number(mode), bytes: Number(length), sha256 };
      }
    } else if (kind === 'hardlink' || kind === 'symlink') {
      const target = entry['target'];
      if (
        !text(target) ||
        target === '' ||
        Object.keys(entry).some((key) => !['path', 'kind', 'target'].includes(key)) ||
        (kind === 'hardlink' && (!validAssetPath(target) || known.get(target) !== 'file'))
      )
        return fail();
      normalized = { path, kind, target };
    } else return fail();
    metadata += Buffer.byteLength(JSON.stringify(normalized));
    if (metadata > 33554432) return fail();
    entries.push(normalized);
    known.set(path, normalized.kind);
  }
  if (bytes !== raw['bytes']) return fail();
  const body = { format: 1 as const, entries, bytes };
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (hash !== raw['hash']) return fail();
  return { ...body, hash };
}
