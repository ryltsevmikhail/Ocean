import { profileBackupSession } from './profile-backup-session.js';
import { checkDependencyPath } from './coding-dependency-path.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { validCodingBackupPresets, type CodingTestPreset } from '@runnets/domain';
import { assetFdPath, privateAssetDirectory } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
export const dependencyHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const dependencyFail = (): never => {
  throw Error('invalid_coding_dependency');
};
export interface FrozenCodingProject {
  readonly id: string;
  readonly root: string;
  readonly testPresets: readonly CodingTestPreset[];
  readonly dependencyProjectRoot?: string;
  readonly mounts: readonly { readonly source: string; readonly target: string }[];
}
export const absoluteDependencyPath = (p: unknown): p is string =>
  typeof p === 'string' && p.length <= 4096 && !p.includes('\0') && p !== '/' && resolve(p) === p;
/** Pure schema parsing: no canonicalWorkspace, live mount resolver or tool setup. */
export function parseFrozenCodingProjects(bytes: Buffer): readonly FrozenCodingProject[] {
  if (bytes.length > 1048576) return dependencyFail();
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.length > 100) return dependencyFail();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return dependencyFail();
    const p = raw as Record<string, unknown>;
    if (
      Object.keys(p).some(
        (k) => !['id', 'root', 'testPresets', 'dependencyProjectRoot', 'mounts'].includes(k),
      ) ||
      typeof p['id'] !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(p['id']) ||
      !absoluteDependencyPath(p['root']) ||
      !validCodingBackupPresets(p['testPresets']) ||
      (p['dependencyProjectRoot'] !== undefined &&
        !absoluteDependencyPath(p['dependencyProjectRoot'])) ||
      !Array.isArray(p['mounts']) ||
      p['mounts'].length > 100
    )
      return dependencyFail();
    for (const rawMount of p['mounts'] as unknown[]) {
      if (!rawMount || typeof rawMount !== 'object' || Array.isArray(rawMount))
        return dependencyFail();
      const m = rawMount as Record<string, unknown>;
      if (
        Object.keys(m).some((k) => !['source', 'target'].includes(k)) ||
        !absoluteDependencyPath(m['source']) ||
        !absoluteDependencyPath(m['target']) ||
        (m['target'] !== '/toolchain/pnpm/bin/pnpm' &&
          (!absoluteDependencyPath(p['dependencyProjectRoot']) ||
            !/^\/workspace\/(?:[A-Za-z0-9_-]+\/)*node_modules$/.test(m['target']) ||
            m['source'] !== join(p['dependencyProjectRoot'], relative('/workspace', m['target']))))
      )
        return dependencyFail();
    }
  }
  const projects = value as FrozenCodingProject[];
  for (const project of projects)
    if (
      new Set(project.mounts.map((m) => m.target)).size !== project.mounts.length ||
      project.mounts.some((a) =>
        project.mounts.some((b) => a !== b && a.target.startsWith(b.target + '/')),
      )
    )
      return dependencyFail();
  if (
    new Set(projects.map((p) => p.id)).size !== projects.length ||
    new Set(projects.map((p) => p.root)).size !== projects.length
  )
    return dependencyFail();
  return projects;
}
export interface FrozenCodingConfiguration {
  readonly presence: 'present' | 'absent';
  readonly bytes: string | null;
  readonly sha256: string | null;
}
/** The owning profile must already be under maintenance ownership. Keeps absence and content witnesses private. */
export function holdCodingConfiguration(profile: string) {
  profileBackupSession.getStore()?.checkMetadata();
  const root = privateAssetDirectory(profile);
  let file: number | undefined;
  try {
    const path = join(profile, 'coding-projects.json'),
      at = join(assetFdPath(root), 'coding-projects.json');
    const rootState = codingAssetIdentity(fs.fstatSync(root, { bigint: true })),
      mount = codingAssetMount(root);
    const stat = fs.lstatSync(at, { bigint: true, throwIfNoEntry: false });
    let bytes: Buffer | null = null,
      state: string | null = null;
    if (stat) {
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o7077n) !== 0n ||
        stat.size > 1048576n
      )
        return dependencyFail();
      file = fs.openSync(
        at,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      state = codingAssetIdentity(stat);
      if (
        codingAssetIdentity(fs.fstatSync(file, { bigint: true })) !== state ||
        codingAssetMount(file) !== mount
      )
        return dependencyFail();
      checkDependencyPath(file, path);
      bytes = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < bytes.length) {
        const n = fs.readSync(file, bytes, offset, bytes.length - offset, offset);
        if (!n) return dependencyFail();
        offset += n;
      }
    }
    const verify = (metadataOnly = false) => {
      checkDependencyPath(root, profile);
      if (
        codingAssetIdentity(fs.fstatSync(root, { bigint: true })) !== rootState ||
        codingAssetMount(root) !== mount
      )
        throw Error('stale_coding_asset');
      const now = fs.lstatSync(at, { bigint: true, throwIfNoEntry: false });
      if (file === undefined) {
        if (now) throw Error('stale_coding_asset');
        return;
      }
      checkDependencyPath(file, path);
      if (
        !now ||
        codingAssetIdentity(now) !== state ||
        codingAssetIdentity(fs.fstatSync(file, { bigint: true })) !== state ||
        codingAssetMount(file) !== mount
      )
        throw Error('stale_coding_asset');
      if (metadataOnly) return;
      const current = Buffer.alloc(bytes!.length);
      let offset = 0;
      while (offset < current.length) {
        const n = fs.readSync(file, current, offset, current.length - offset, offset);
        if (!n) throw Error('stale_coding_asset');
        offset += n;
      }
      if (!current.equals(bytes!)) throw Error('stale_coding_asset');
    };
    verify();
    const configuration: FrozenCodingConfiguration = {
      presence: bytes ? 'present' : 'absent',
      bytes: bytes?.toString('base64') ?? null,
      sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    };
    return {
      configuration,
      projects: bytes ? parseFrozenCodingProjects(bytes) : [],
      verify,
      close: () => {
        if (file !== undefined) fs.closeSync(file);
        fs.closeSync(root);
      },
    };
  } catch (error) {
    if (file !== undefined) fs.closeSync(file);
    fs.closeSync(root);
    throw error;
  }
}
