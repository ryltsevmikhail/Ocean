import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseManifest } from './installer-types.js';
export type { ReleaseBundleRecord, ReleaseManifest } from './installer-types.js';
const MCP_ROOT = 'node_modules/@runnets/integrations-mcp/';
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
  try {
    validateBundle(m, files);
  } catch {
    throw Error('invalid_manifest');
  }
  return m;
}
function validateBundle(
  { bundle: b }: ReleaseManifest,
  files: Map<string, { body: Buffer; mode: number }>,
): void {
  const present = [...files.keys()].some((name) => name.startsWith(MCP_ROOT));
  if (b === undefined) {
    if (present) throw Error('invalid_manifest');
    return;
  }
  const modern = b.adapter === '@runnets/integrations-mcp';
  const base = 'node_modules/' + b.adapter + '/',
    integrity = files.get(base + 'dist/bundle-integrity.json');
  if (
    present !== modern ||
    (!modern && b.adapter !== '@runnets/integrations-executor') ||
    b.entry !== 'dist/index.js' ||
    b.integrity !== 'dist/bundle-integrity.json' ||
    !/^[a-f0-9]{64}$/.test(b.integritySha256) ||
    integrity === undefined ||
    sha256(integrity.body) !== b.integritySha256 ||
    typeof b.files[b.entry] !== 'string' ||
    (modern
      ? b.identities['@modelcontextprotocol/client'] !== '2.4.0' ||
        b.identities['@modelcontextprotocol/core'] !== '2.4.0' ||
        b.identities['bundler#rolldown'] !== '1.2.16'
      : typeof b.identities['@executor-js/sdk'] !== 'string') ||
    !files.has(base + 'package.json') ||
    !files.has(base + 'LICENSE')
  )
    throw new Error('invalid_manifest');
  if (modern) {
    const record = JSON.parse(integrity.body.toString()) as {
      format: number;
      files: Record<string, string>;
      pinnedVersions: object;
      identities: object;
      bundler: object;
    };
    const same = (a: object, b: object) =>
      JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    if (
      record.format !== 1 ||
      !same(record.pinnedVersions, { client: '2.4.0', core: '2.4.0' }) ||
      !same(record.identities, b.identities) ||
      !same(record.bundler, { name: 'rolldown', version: '1.2.16' })
    )
      throw Error('invalid_manifest');
    const shipped = [...files.keys()].filter((name) => name.startsWith(base + 'dist/'));
    if (
      shipped.length !== Object.keys(b.files).length ||
      Object.keys(record.files).length + 1 !== shipped.length
    )
      throw Error('invalid_manifest');
    for (const name of shipped) {
      const relative = name.slice(base.length),
        digest = sha256(files.get(name)!.body);
      if (
        b.files[relative] !== digest ||
        (relative !== b.integrity && record.files[relative.slice(5)] !== digest)
      )
        throw Error('invalid_manifest');
    }
  }
}
function durable(path: string): void {
  const fd = fs.openSync(path, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function syncTree(path: string): void {
  for (const e of fs.readdirSync(path, { withFileTypes: true }))
    if (e.isDirectory()) syncTree(join(path, e.name));
    else durable(join(path, e.name));
  durable(path);
}
function safeParent(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('invalid_prefix');
  for (let at = path; at !== '/'; at = dirname(at))
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error('invalid_prefix');
}
function switchCurrent(base: string, version: string): void {
  const current = join(base, 'current');
  let currentStat: ReturnType<typeof fs.lstatSync> | null = null;
  try {
    currentStat = fs.lstatSync(current);
  } catch {
    currentStat = null;
  }
  if (
    currentStat !== null &&
    (!currentStat.isSymbolicLink() || !/^releases\/[a-zA-Z0-9.-]+$/.test(fs.readlinkSync(current)))
  )
    throw new Error('unmanaged_current');
  const temp = join(base, '.current-' + randomUUID());
  fs.symlinkSync('releases/' + version, temp);
  try {
    fs.renameSync(temp, current);
    durable(base);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function installArchive(archive: string, checksum: string, prefix: string): ReleaseManifest {
  safeParent(prefix);
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    process.versions.node.split('.')[0] !== '26'
  )
    throw new Error('unsupported_runtime');
  const bytes = fs.readFileSync(archive);
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
  try {
    const s = fs.lstatSync(launcher);
    if (!s.isSymbolicLink() || fs.readlinkSync(launcher) !== '../lib/ocean/current/bin/ocean')
      throw new Error('unmanaged_launcher');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  if (fs.existsSync(destination)) {
    const old = fs.readFileSync(join(destination, 'manifest.json'));
    if (!old.equals(files.get('manifest.json')!.body)) throw new Error('version_conflict');
    const actual: string[] = [];
    const visit = (path: string, relative: string) => {
      for (const e of fs.readdirSync(path, { withFileTypes: true })) {
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
      const mode = fs.lstatSync(path).mode & 0o777;
      if (!fs.readFileSync(path).equals(e.body) || ![e.mode, e.mode & 0o700].includes(mode))
        throw new Error('version_conflict');
    }
    for (const [name, entry] of files) {
      const path = join(destination, name);
      fs.chmodSync(path, entry.mode);
      durable(path);
    }
  } else {
    const stage = join(releases, '.install-' + randomUUID());
    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      for (const [name, e] of files) {
        const path = join(stage, name);
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path, e.body, { flag: 'wx', mode: e.mode });
        fs.chmodSync(path, e.mode);
      }
      syncTree(stage);
      fs.renameSync(stage, destination);
      durable(releases);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  switchCurrent(base, manifest.version);
  try {
    fs.symlinkSync('../lib/ocean/current/bin/ocean', launcher);
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
