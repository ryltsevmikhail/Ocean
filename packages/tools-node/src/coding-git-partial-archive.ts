import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CodingPartialGitCapture } from './coding-git-partial.js';
import type { CodingGitAdministration } from './coding-git-administration.js';
import { assertPartialGitOrigin } from './coding-git-partial-origin.js';
import { gitDigest } from './coding-git-observer.js';
import {
  assetDirectoryFlags,
  assetFdPath,
  assetNames,
  checkAssetPath,
  privateAssetDirectory,
} from './coding-asset-io.js';
import { GitEvidenceObserver } from './coding-git-observer.js';
const fail = (): never => {
  throw Error('invalid_partial_git_archive');
};
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function parse(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  } catch {
    return fail();
  }
}
function admin(bytes: Buffer, expected: string): CodingGitAdministration {
  const value = parse(bytes),
    { hash, ...body } = value;
  if (
    hash !== expected ||
    gitDigest(JSON.stringify(body)) !== hash ||
    body['format'] !== 1 ||
    !['present', 'absent'].includes(String(body['root'])) ||
    !['present', 'absent'].includes(String(body['index'])) ||
    !(
      body['branch'] === null ||
      (typeof body['branch'] === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body['branch']))
    ) ||
    !(
      body['admin'] === null ||
      (typeof body['admin'] === 'string' &&
        /^[a-f0-9]{64}(?:[1-9][0-9]{0,8})?$/.test(body['admin']))
    ) ||
    !Array.isArray(body['files']) ||
    body['files'].length > 4
  )
    return fail();
  const names: string[] = [];
  const files: unknown[] = body['files'];
  for (const candidate of files) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail();
    const file = candidate as Record<string, unknown>;
    const name = file['name'],
      raw = file['body'],
      digest = file['sha256'];
    if (
      typeof name !== 'string' ||
      typeof raw !== 'string' ||
      !sha(digest) ||
      Object.keys(file).sort().join(',') !== 'body,name,sha256'
    )
      return fail();
    if (
      !['root/.git', 'admin/HEAD', 'admin/commondir', 'admin/gitdir'].includes(name) ||
      names.includes(name)
    )
      return fail();
    const content = Buffer.from(raw, 'base64');
    if (
      content.length > 4096 ||
      content.toString('base64') !== raw ||
      gitDigest(content) !== digest
    )
      return fail();
    names.push(name);
  }
  const expectedNames = [
    ...(body['root'] === 'present' ? ['root/.git'] : []),
    ...(body['admin'] === null ? [] : ['admin/HEAD', 'admin/commondir', 'admin/gitdir']),
  ];
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name)) ||
    (body['admin'] === null && (body['index'] !== 'absent' || body['root'] !== 'absent'))
  )
    return fail();
  return value as unknown as CodingGitAdministration;
}
/** Private inert evidence only; absolute source pointers never become operational Git paths. */
export function archivePartialCodingGit(capture: CodingPartialGitCapture, path: string): string {
  assertPartialGitOrigin(capture, path);
  const { index, pack, administration, ...fields } = capture;
  const administrationBytes = Buffer.from(JSON.stringify(administration));
  const manifest = Buffer.from(
    JSON.stringify({
      ...fields,
      packBytes: pack.length,
      indexBytes: index?.length ?? null,
      administrationHash: administration.hash,
      administrationSha256: gitDigest(administrationBytes),
    }),
  );
  const expected = gitDigest(manifest);
  if (fs.realpathSync(dirname(path)) !== dirname(path) || fs.existsSync(path))
    throw Error('invalid_coding_asset_destination');
  const parent = fs.openSync(dirname(path), assetDirectoryFlags);
  let output: number;
  try {
    checkAssetPath(parent, dirname(path));
    fs.mkdirSync(join(assetFdPath(parent), basename(path)), { mode: 0o700 });
    checkAssetPath(parent, dirname(path));
    output = privateAssetDirectory(path);
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  try {
    const write = (name: string, body: Buffer | string) => {
      const fd = fs.openSync(
        join(assetFdPath(output), name),
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      checkAssetPath(output, path);
    };
    write('incomplete', 'partial Git evidence\n');
    fs.fsyncSync(output);
    write('pack', pack);
    if (index !== null) write('index', index);
    write('administration.json', administrationBytes);
    write('manifest.json', manifest);
    assertPartialGitOrigin(capture, path);
    // Verify through separate nofollow readers before publication, retaining the marker on failure.
    verifyArchive(path, expected, true);
    checkAssetPath(output, path);
    fs.unlinkSync(join(assetFdPath(output), 'incomplete'));
    fs.fsyncSync(output);
    return expected;
  } finally {
    fs.closeSync(output);
  }
}
export function verifyPartialCodingGitArchive(
  path: string,
  expected: string,
): CodingPartialGitCapture {
  return verifyArchive(path, expected, false);
}
function verifyArchive(
  path: string,
  expected: string,
  incomplete: boolean,
): CodingPartialGitCapture {
  if (!sha(expected)) return fail();
  const privateFd = privateAssetDirectory(path),
    observer = new GitEvidenceObserver();
  try {
    const fd = observer.directory(path)!;
    const manifest = observer.file(fd, 'manifest.json', 8388608);
    if (!manifest || gitDigest(manifest) !== expected) return fail();
    const m = parse(manifest);
    if (
      m['format'] !== 1 ||
      !['sha1', 'sha256'].includes(String(m['objectFormat'])) ||
      !sha(m['packSha256']) ||
      !sha(m['administrationHash']) ||
      !sha(m['administrationSha256'])
    )
      return fail();
    const oid = new RegExp('^[a-f0-9]{' + (m['objectFormat'] === 'sha1' ? 40 : 64) + '}$');
    if (
      typeof m['baseCommit'] !== 'string' ||
      !oid.test(m['baseCommit']) ||
      !Array.isArray(m['objectIds']) ||
      m['objectIds'].length > 100000 ||
      !m['objectIds'].includes(m['baseCommit']) ||
      m['objectIds'].some((id) => typeof id !== 'string' || !oid.test(id)) ||
      new Set(m['objectIds']).size !== m['objectIds'].length
    )
      return fail();
    for (const [field, limit] of [
      ['objectBytes', 2147483648],
      ['packBytes', 268435456],
    ] as const)
      if (!Number.isSafeInteger(m[field]) || Number(m[field]) < 0 || Number(m[field]) > limit)
        return fail();
    const indexBytes = m['indexBytes'];
    if (
      !(indexBytes === null
        ? m['indexSha256'] === null
        : Number.isSafeInteger(indexBytes) &&
          Number(indexBytes) >= 0 &&
          Number(indexBytes) <= 16777216 &&
          sha(m['indexSha256']))
    )
      return fail();
    const names = [
      'administration.json',
      'manifest.json',
      'pack',
      ...(indexBytes === null ? [] : ['index']),
      ...(incomplete ? ['incomplete'] : []),
    ].sort();
    if (JSON.stringify(assetNames(fd, 6)) !== JSON.stringify(names)) return fail();
    const pack = observer.file(fd, 'pack', 268435456),
      index = indexBytes === null ? null : observer.file(fd, 'index', 16777216),
      metadata = observer.file(fd, 'administration.json', 32768);
    if (
      !pack ||
      pack.length !== m['packBytes'] ||
      gitDigest(pack) !== m['packSha256'] ||
      !metadata ||
      gitDigest(metadata) !== m['administrationSha256'] ||
      (indexBytes !== null &&
        (!index || index.length !== indexBytes || gitDigest(index) !== m['indexSha256']))
    )
      return fail();
    const administration = admin(metadata, m['administrationHash']);
    if (
      (index === null) !== (administration.index === 'absent') ||
      pack.length < 12 ||
      pack.subarray(0, 4).toString() !== 'PACK' ||
      ![2, 3].includes(pack.readUInt32BE(4)) ||
      pack.readUInt32BE(8) !== m['objectIds'].length
    )
      return fail();
    observer.verify();
    checkAssetPath(privateFd, path);
    return {
      format: 1,
      baseCommit: m['baseCommit'],
      objectFormat: m['objectFormat'] as 'sha1' | 'sha256',
      objectIds: m['objectIds'] as string[],
      objectBytes: Number(m['objectBytes']),
      index,
      indexSha256: m['indexSha256'] as string | null,
      pack,
      packSha256: m['packSha256'],
      administration,
    };
  } finally {
    observer.close();
    fs.closeSync(privateFd);
  }
}
