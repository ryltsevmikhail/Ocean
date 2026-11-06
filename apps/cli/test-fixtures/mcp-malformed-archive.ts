import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// eslint-disable-next-line no-restricted-imports -- Same-package CLI test fixture; CLI has no library export.
import { createArchive } from '../src/release/archive.ts';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function malformed(root: string, mode: string) {
  const base = 'node_modules/@runnets/integrations-mcp/';
  const files = new Map<string, { body: Buffer; mode: number }>();
  const add = (name: string, value: string) =>
    files.set(name, { body: Buffer.from(value), mode: 0o644 });
  for (const name of [
    'bin/ocean',
    'apps/cli/dist/main.js',
    'LICENSE',
    'NOTICE',
    'package.json',
    base + 'package.json',
    base + 'LICENSE',
  ])
    add(name, '{}');
  add(base + 'dist/index.js', 'export const fixture = true;');
  const identities = {
    '@modelcontextprotocol/client': '2.4.0',
    '@modelcontextprotocol/core': '2.4.0',
    'bundler#rolldown': mode === 'outer-bundler' ? '9.9.9' : '1.2.16',
  };
  const record = {
    format: mode === 'format' ? 2 : 1,
    pinnedVersions: { client: mode === 'pins' ? '2.5.0' : '2.4.0', core: '2.4.0' },
    identities:
      mode === 'identities' ? { ...identities, '@modelcontextprotocol/core': '2.5.0' } : identities,
    bundler: { name: 'rolldown', version: mode === 'bundler' ? '9.9.9' : '1.2.16' },
    files: { 'index.js': sha256(files.get(base + 'dist/index.js')!.body) },
  };
  if (mode !== 'absent') add(base + 'dist/bundle-integrity.json', JSON.stringify(record));
  const bundle = {
    adapter: '@runnets/integrations-mcp',
    entry: 'dist/index.js',
    integrity: 'dist/bundle-integrity.json',
    integritySha256:
      mode === 'absent'
        ? 'a'.repeat(64)
        : sha256(files.get(base + 'dist/bundle-integrity.json')!.body),
    files: Object.fromEntries(
      [...files]
        .filter(([name]) => name.startsWith(base + 'dist/'))
        .map(([name, file]) => [name.slice(base.length), sha256(file.body)]),
    ),
    identities,
  };
  const manifest = {
    format: 1,
    version: '1.1.0-test',
    revision: 'a'.repeat(40),
    node: process.version,
    platform: 'linux',
    arch: 'x64',
    lockfileSha256: 'b'.repeat(64),
    files: Object.fromEntries(
      [...files].map(([name, file]) => [name, { sha256: sha256(file.body), mode: file.mode }]),
    ),
    ...(mode === 'absent' ? {} : { bundle }),
  };
  add('manifest.json', JSON.stringify(manifest));
  const bytes = createArchive(files),
    archive = join(root, mode + '.tar.gz');
  writeFileSync(archive, bytes);
  return { archive, checksum: sha256(bytes) };
}
