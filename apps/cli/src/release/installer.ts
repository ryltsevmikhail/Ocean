/** Standalone Node-only installer; this compiled file is also shipped beside the archive. */
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build-recorded bundle inventory for the one pre-bundled runtime adapter. */
export interface ReleaseBundleRecord {
  readonly adapter: string;
  readonly entry: string;
  readonly integrity: string;
  readonly integritySha256: string;
  readonly files: Readonly<Record<string, string>>;
  readonly identities: Readonly<Record<string, string>>;
}
export interface ReleaseManifest {
  readonly format: 1;
  readonly version: string;
  readonly revision: string;
  readonly node: string;
  readonly platform: 'linux';
  readonly arch: 'x64';
  readonly lockfileSha256: string;
  readonly files: Readonly<Record<string, { sha256: string; mode: number }>>;
  /** Present when the archive ships the pre-bundled Executor adapter. */
  readonly bundle?: ReleaseBundleRecord;
}
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function archiveFiles(bytes: Buffer): Map<string, { body: Buffer; mode: number }> {
  const raw = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map<string, { body: Buffer; mode: number }>();
  let offset = 0;
  const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= raw.length) {
    const h = raw.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) {
      if (raw.length - offset < 1024 || !raw.subarray(offset).every((b) => b === 0))
        throw new Error('invalid_archive');
      return files;
    }
    const oct = (start: number, length: number) => {
      const value = text(h.subarray(start, start + length)).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error('invalid_archive');
      return parseInt(value, 8);
    };
    const checksum = oct(148, 8);
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    const prefix = text(h.subarray(345, 500));
    const path = (prefix ? prefix + '/' : '') + text(h.subarray(0, 100));
    const size = oct(124, 12),
      mode = oct(100, 8);
    if (
      checksum !== sum ||
      text(h.subarray(257, 263)) !== 'ustar' ||
      h[156] !== 48 ||
      !path ||
      isAbsolute(path) ||
      path.includes('\\') ||
      path.split('/').some((p) => !p || p === '.' || p === '..') ||
      !/^[a-zA-Z0-9@._/+-]+$/.test(path) ||
      files.has(path) ||
      ![0o644, 0o755].includes(mode) ||
      size > raw.length - offset - 512
    )
      throw new Error('invalid_archive');
    files.set(path, { body: Buffer.from(raw.subarray(offset + 512, offset + 512 + size)), mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('invalid_archive');
}
function manifestOf(files: Map<string, { body: Buffer; mode: number }>): ReleaseManifest {
  const entry = files.get('manifest.json');
  if (!entry) throw new Error('invalid_manifest');
  let m: ReleaseManifest;
  try {
    m = JSON.parse(entry.body.toString()) as ReleaseManifest;
  } catch {
    throw new Error('invalid_manifest');
  }
  if (
    m.format !== 1 ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(m.version) ||
    !/^[a-f0-9]{40}$/.test(m.revision) ||
    m.platform !== 'linux' ||
    m.arch !== 'x64' ||
    !/^v26\./.test(m.node) ||
    !/^[a-f0-9]{64}$/.test(m.lockfileSha256) ||
    typeof m.files !== 'object' ||
    m.files === null ||
    Object.keys(m.files).length !== files.size - 1
  )
    throw new Error('invalid_manifest');
  for (const [name, entry] of files) {
    if (name === 'manifest.json') continue;
    const expected = m.files[name];
    if (!expected || sha256(entry.body) !== expected.sha256 || entry.mode !== expected.mode)
      throw new Error('invalid_manifest');
  }
  for (const name of ['bin/ocean', 'apps/cli/dist/main.js', 'LICENSE', 'NOTICE', 'package.json'])
    if (!files.has(name)) throw new Error('invalid_manifest');
  validateBundle(m, files);
  return m;
}
/**
 * Cross-check the optional bundled-adapter record against the shipped bytes.
 * Per-file archive integrity is the manifest map above; this keeps the published
 * bundle facts anchored to the same bytes the installed adapter re-verifies.
 */
function validateBundle(
  m: ReleaseManifest,
  files: Map<string, { body: Buffer; mode: number }>,
): void {
  const b = m.bundle;
  if (b === undefined) return;
  const base = 'node_modules/@runnets/integrations-executor/',
    integrity = files.get(base + 'dist/bundle-integrity.json');
  if (
    b.adapter !== '@runnets/integrations-executor' ||
    b.entry !== 'dist/index.js' ||
    b.integrity !== 'dist/bundle-integrity.json' ||
    !/^[a-f0-9]{64}$/.test(b.integritySha256) ||
    integrity === undefined ||
    sha256(integrity.body) !== b.integritySha256 ||
    typeof b.files[b.entry] !== 'string' ||
    typeof b.identities['@executor-js/sdk'] !== 'string' ||
    !files.has(base + 'package.json') ||
    !files.has(base + 'LICENSE')
  )
    throw new Error('invalid_manifest');
}
function durable(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncTree(path: string): void {
  for (const e of readdirSync(path, { withFileTypes: true }))
    if (e.isDirectory()) syncTree(join(path, e.name));
    else durable(join(path, e.name));
  durable(path);
}
function safeParent(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('invalid_prefix');
  for (let at = path; at !== '/'; at = dirname(at))
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error('invalid_prefix');
}
function switchCurrent(base: string, version: string): void {
  const current = join(base, 'current');
  let currentStat: ReturnType<typeof lstatSync> | null = null;
  try {
    currentStat = lstatSync(current);
  } catch {
    currentStat = null;
  }
  if (
    currentStat !== null &&
    (!currentStat.isSymbolicLink() || !/^releases\/[a-zA-Z0-9.-]+$/.test(readlinkSync(current)))
  )
    throw new Error('unmanaged_current');
  const temp = join(base, '.current-' + randomUUID());
  symlinkSync('releases/' + version, temp);
  try {
    renameSync(temp, current);
    durable(base);
  } finally {
    rmSync(temp, { force: true });
  }
}
/** Trusted archive checksum is required BEFORE decompression or filesystem writes. */
export function installArchive(archive: string, checksum: string, prefix: string): ReleaseManifest {
  safeParent(prefix);
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.versions.node.split('.')[0] !== '26'
  )
    throw new Error('unsupported_runtime');
  const bytes = readFileSync(archive);
  if (!/^[a-f0-9]{64}$/.test(checksum) || sha256(bytes) !== checksum)
    throw new Error('checksum_mismatch');
  const files = archiveFiles(bytes),
    manifest = manifestOf(files);
  const base = join(prefix, 'lib', 'ocean'),
    releases = join(base, 'releases');
  const destination = join(releases, manifest.version),
    launcher = join(prefix, 'bin', 'ocean');
  safeParent(destination);
  safeParent(dirname(launcher));
  // Refuse an unrelated launcher before installing or switching anything.
  try {
    const s = lstatSync(launcher);
    if (!s.isSymbolicLink() || readlinkSync(launcher) !== '../lib/ocean/current/bin/ocean')
      throw new Error('unmanaged_launcher');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  if (existsSync(destination)) {
    const old = readFileSync(join(destination, 'manifest.json'));
    if (!old.equals(files.get('manifest.json')!.body)) throw new Error('version_conflict');
    const actual: string[] = [];
    const visit = (path: string, relative: string) => {
      for (const e of readdirSync(path, { withFileTypes: true })) {
        const name = relative + e.name;
        if (e.isDirectory()) visit(join(path, e.name), name + '/');
        else if (e.isFile()) actual.push(name);
        else throw new Error('version_conflict');
      }
    };
    visit(destination, '');
    if (actual.length !== files.size) throw new Error('version_conflict');
    for (const [name, e] of files) {
      const path = join(destination, name);
      const mode = lstatSync(path).mode & 0o777;
      // Earlier installers applied the caller's private umask to public program files.
      if (!readFileSync(path).equals(e.body) || ![e.mode, e.mode & 0o700].includes(mode))
        throw new Error('version_conflict');
    }
    // Only normalize fully verified public program files, before switching current.
    for (const [name, entry] of files) {
      const path = join(destination, name);
      chmodSync(path, entry.mode);
      durable(path);
    }
  } else {
    const stage = join(releases, '.install-' + randomUUID());
    mkdirSync(stage, { mode: 0o700 });
    try {
      for (const [name, e] of files) {
        const path = join(stage, name);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, e.body, { flag: 'wx', mode: e.mode });
        chmodSync(path, e.mode);
      }
      syncTree(stage);
      renameSync(stage, destination);
      durable(releases);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  switchCurrent(base, manifest.version);
  try {
    symlinkSync('../lib/ocean/current/bin/ocean', launcher);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  durable(dirname(launcher));
  return manifest;
}
export function installCommand(argv: readonly string[]): number {
  try {
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i],
        value = argv[i + 1];
      if (!key || !value || !['--archive', '--sha256', '--prefix'].includes(key) || values.has(key))
        throw new Error('invalid_input');
      values.set(key, value);
    }
    const archive = values.get('--archive'),
      checksum = values.get('--sha256'),
      prefix = values.get('--prefix');
    if (!archive || !checksum || !prefix) throw new Error('invalid_input');
    const m = installArchive(archive, checksum, prefix);
    process.stdout.write(JSON.stringify({ version: m.version, revision: m.revision }) + '\n');
    return 0;
  } catch {
    process.stderr.write(
      'Ocean installation refused; verify checksum, runtime, target and existing files.\n',
    );
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = installCommand(process.argv.slice(2));
