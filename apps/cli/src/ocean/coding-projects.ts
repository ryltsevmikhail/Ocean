import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingTestPreset } from '@runnets/domain';
import { validateMounts, type SandboxOptions } from '@runnets/tools-node';
import { canonicalWorkspace, profileDirectory } from './profile.js';
import { assertPrivate, atomicPrivateJson } from './private-files.js';
export interface RegisteredCodingProject {
  readonly id: string;
  readonly root: string;
  readonly testPresets: readonly CodingTestPreset[];
  readonly dependencyProjectRoot?: string;
  readonly mounts: NonNullable<SandboxOptions['mounts']>;
}
export async function validateCodingProject(value: unknown): Promise<RegisteredCodingProject> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid project configuration');
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (key) => !['id', 'root', 'testPresets', 'dependencyProjectRoot', 'mounts'].includes(key),
    ) ||
    typeof p['id'] !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(p['id']) ||
    typeof p['root'] !== 'string' ||
    !Array.isArray(p['testPresets']) ||
    !Array.isArray(p['mounts'])
  )
    throw Error('invalid project configuration');
  const presets = p['testPresets'] as unknown[],
    ids = new Set<string>();
  for (const raw of presets) {
    if (!raw || typeof raw !== 'object') throw Error('invalid test preset');
    const preset = raw as Record<string, unknown>;
    if (
      Object.keys(preset).some((key) => !['id', 'program', 'args', 'cwd'].includes(key)) ||
      typeof preset['id'] !== 'string' ||
      !preset['id'] ||
      ids.has(preset['id']) ||
      typeof preset['program'] !== 'string' ||
      !preset['program'].startsWith('/') ||
      preset['program'].includes('\0') ||
      preset['cwd'] !== '.' ||
      !Array.isArray(preset['args']) ||
      preset['args'].length > 128 ||
      preset['args'].some(
        (arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 8192,
      )
    )
      throw Error('invalid test preset');
    ids.add(preset['id']);
  }
  const mounts = p['mounts'] as unknown[];
  for (const raw of mounts) {
    if (!raw || typeof raw !== 'object') throw Error('invalid mount');
    const m = raw as Record<string, unknown>;
    if (
      Object.keys(m).some((key) => key !== 'source' && key !== 'target') ||
      typeof m['source'] !== 'string' ||
      typeof m['target'] !== 'string'
    )
      throw Error('invalid mount');
  }
  if (p['dependencyProjectRoot'] !== undefined && typeof p['dependencyProjectRoot'] !== 'string')
    throw Error('invalid dependency root');
  const project = structuredClone(value) as RegisteredCodingProject;
  const root = canonicalWorkspace(project.root);
  if (root !== project.root) throw Error('canonical project root required');
  await validateMounts(project.mounts, project.dependencyProjectRoot);
  return project;
}
export async function readCodingProjects(
  profile?: string,
): Promise<readonly RegisteredCodingProject[]> {
  const path = join(profileDirectory(profile), 'coding-projects.json');
  if (!existsSync(path)) return [];
  assertPrivate(path, false);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length > 100) throw Error('invalid project registry');
  const projects = await Promise.all(raw.map(validateCodingProject));
  if (new Set(projects.map((p) => p.id)).size !== projects.length)
    throw Error('duplicate project ID');
  return projects;
}
export async function registerCodingProject(
  profile: string | undefined,
  value: unknown,
  confirm: (preview: RegisteredCodingProject) => Promise<boolean>,
): Promise<RegisteredCodingProject> {
  const project = await validateCodingProject(value),
    projects = await readCodingProjects(profile);
  if (projects.some((p) => p.id === project.id || p.root === project.root))
    throw Error('project already registered');
  if (!(await confirm(structuredClone(project)))) throw Error('approval_required');
  assertPrivate(profileDirectory(profile), true);
  atomicPrivateJson(join(profileDirectory(profile), 'coding-projects.json'), [
    ...projects,
    project,
  ]);
  return project;
}
