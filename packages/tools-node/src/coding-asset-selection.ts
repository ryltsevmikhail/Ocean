import { dirname, basename } from 'node:path';
export function validAssetPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= 4096 &&
    Buffer.from(value).toString('utf8') === value &&
    value
      .split('/')
      .every((part) => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255)
  );
}
/** Bounded trie of exact endpoints and their ancestors. No filesystem discovery. */
export function planAssetSelection(
  input: readonly string[],
  limits: { entries: number; depth: number },
) {
  if (!Array.isArray(input) || !input.length || input.length >= limits.entries)
    throw Error('invalid_coding_asset_selection');
  const files = new Set<string>(),
    children = new Map<string, Set<string>>([['', new Set()]]);
  let metadata = 0;
  for (const path of input) {
    if (
      !validAssetPath(path) ||
      files.has(path) ||
      children.has(path) ||
      path.split('/').length > limits.depth
    )
      throw Error('invalid_coding_asset_selection');
    files.add(path);
    let child = path;
    while (child) {
      const directory = dirname(child),
        parent = directory === '.' ? '' : directory;
      if (files.has(parent)) throw Error('invalid_coding_asset_selection');
      const names = children.get(parent) ?? new Set<string>();
      children.set(parent, names);
      const name = basename(child);
      if (names.has(name)) break;
      names.add(name);
      metadata += Buffer.byteLength(child) + 32;
      if (metadata > 16777216 || children.size + files.size > limits.entries)
        throw Error('coding_asset_limit');
      child = parent;
    }
  }
  const paths = [...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { paths, files, children };
}
export type AssetSelection = ReturnType<typeof planAssetSelection>;
