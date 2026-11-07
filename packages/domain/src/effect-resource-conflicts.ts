import { managedPairDisjoint, type ManagedWorkspacePair } from './managed-workspace.js';
import {
  validEffectResourceScope,
  type EffectResourceScope,
  type OwnerResourceScope,
} from './effect-resource-scope.js';
import { validOwnerGrantReference, type OwnerGrantReference } from './owner-scope-grant.js';
import { validServiceJson, type ServiceJson } from './service-catalog.js';
import {
  authorityBoundedJson,
  authorityKeys,
  authorityObject,
} from './service-authority-validation.js';
import { projectRootsOverlap } from './coding-task.js';
export interface ToolEffectAdmission {
  readonly scope: EffectResourceScope;
  readonly effectKind: 'observation' | 'mutation';
  readonly grantReference: OwnerGrantReference | null;
  readonly binding: ServiceJson;
}
export function validToolEffectAdmission(v: unknown): v is ToolEffectAdmission {
  return (
    authorityObject(v) &&
    authorityKeys(v, ['scope', 'effectKind', 'grantReference', 'binding']) &&
    validEffectResourceScope(v.scope) &&
    (v.effectKind === 'observation' || v.effectKind === 'mutation') &&
    (v.grantReference === null || validOwnerGrantReference(v.grantReference)) &&
    validServiceJson(v.binding) &&
    authorityBoundedJson(v, 2 * 1024 * 1024)
  );
}
function canonicalRoot(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..')
  );
}
function disjoint(
  a: OwnerResourceScope,
  b: OwnerResourceScope,
  existing: ToolEffectAdmission,
  incoming: ToolEffectAdmission,
): boolean {
  if (a.kind === 'project-worktree' && b.kind === 'project-worktree') {
    const root = (resource: typeof a, metadata: ToolEffectAdmission) => {
      const binding = metadata.binding;
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
      const value = (binding as Readonly<Record<string, ServiceJson>>)[
        resource.worktreeId === null ? 'projectRoot' : 'worktreeRoot'
      ];
      return typeof value === 'string' && canonicalRoot(value) ? value.toLowerCase() : null;
    };
    if (
      (a.worktreeId !== null && a.worktreeId === b.worktreeId) ||
      (a.projectId === b.projectId && (a.worktreeId === null || b.worktreeId === null))
    )
      return false;
    const ar = root(a, existing),
      br = root(b, incoming);
    return !!ar && !!br && !projectRootsOverlap(ar, br);
  }
  if (a.kind !== 'github-repository' || b.kind !== 'github-repository') return false;
  const left = a.repository.toLowerCase(),
    right = b.repository.toLowerCase();
  const leftId = githubRepositoryId(existing.binding, left),
    rightId = githubRepositoryId(incoming.binding, right);
  return left !== right && leftId !== null && rightId !== null && leftId !== rightId;
}
// Only durable GitHub.com numeric identities certified by the trusted adapter partition aliases.
function githubRepositoryId(binding: ServiceJson, name: string): string | null {
  if (!authorityObject(binding) || !authorityObject(binding['githubRepositoryIds'])) return null;
  const id = binding['githubRepositoryIds'][name];
  return typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) ? id : null;
}
export function effectResourcesConflict(
  existing: ToolEffectAdmission | undefined,
  incoming: ToolEffectAdmission | undefined,
  pair?: ManagedWorkspacePair,
): boolean {
  if (!existing || !incoming) return true;
  if (incoming.effectKind === 'observation' && incoming.scope.kind === 'resources') return false;
  if (existing.scope.kind !== 'resources' || incoming.scope.kind !== 'resources') return true;
  if (managedPairDisjoint(existing, incoming, pair)) return false;
  const resources = incoming.scope.resources;
  return existing.scope.resources.some((a) =>
    resources.some((b) => !disjoint(a, b, existing, incoming)),
  );
}
