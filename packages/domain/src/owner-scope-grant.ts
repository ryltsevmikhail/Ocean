import { validOwnerResources, type OwnerResourceScope } from './effect-resource-scope.js';
import {
  authorityDenseArray,
  authorityBoundedJson,
  authorityInstant as instant,
  authorityKeys as keys,
  authorityNames as names,
  authorityObject as object,
  authorityRevision as revision,
  authorityText as text,
} from './service-authority-validation.js';
export type OwnerToolPolicy =
  | { readonly kind: 'exact' | 'current-set'; readonly names: readonly string[] }
  | { readonly kind: 'all-including-future'; readonly explicitlySelected: true };
export const OWNER_CODING_ACTIONS = [
  'project_read',
  'propose_write',
  'run_test_preset',
  'changeset_read',
  'apply_changeset',
  'commit',
  'push',
  'deploy',
] as const;
export type OwnerPermission =
  | {
      readonly kind: 'service';
      readonly connectionId: string;
      readonly trustRevision: number;
      readonly baselineCatalogId?: string;
      readonly tools: OwnerToolPolicy;
      readonly resources: readonly OwnerResourceScope[];
    }
  | {
      readonly kind: 'coding';
      readonly actions: readonly (typeof OWNER_CODING_ACTIONS)[number][];
      readonly resources: readonly OwnerResourceScope[];
    };
export interface OwnerGrantReference {
  readonly grantId: string;
  readonly revision: number;
}
export interface OwnerScopeGrant {
  readonly id: string;
  readonly policyVersion: 2;
  readonly revision: number;
  readonly state: 'active' | 'revoked';
  readonly owner: {
    readonly ownerId: string;
    readonly issuedAt: string;
    readonly source: 'owner-interface' | 'owner-migration';
  };
  readonly subject: {
    readonly workspaceId: string;
    readonly roomId: string;
    readonly botId: string;
    readonly projectId: string | null;
    readonly taskId: string | null;
  };
  readonly permissions: readonly OwnerPermission[];
  readonly mode: 'autonomous' | 'confirm';
  readonly limits: {
    readonly maxCalls: number;
    readonly maxEffectBytes: number;
    readonly expiresAt: string | null;
  };
  readonly updatedAt: string;
}
export function validOwnerGrantReference(v: unknown): v is OwnerGrantReference {
  return (
    object(v) && keys(v, ['grantId', 'revision']) && text(v['grantId']) && revision(v['revision'])
  );
}
export function validOwnerToolPolicy(v: unknown): v is OwnerToolPolicy {
  return (
    object(v) &&
    (v['kind'] === 'all-including-future'
      ? keys(v, ['kind', 'explicitlySelected']) && v['explicitlySelected'] === true
      : (v['kind'] === 'exact' || v['kind'] === 'current-set') &&
        keys(v, ['kind', 'names']) &&
        names(v['names']))
  );
}
export function validOwnerPermission(v: unknown): v is OwnerPermission {
  if (!object(v) || !validOwnerResources(v['resources'])) return false;
  if (v['kind'] === 'coding')
    return (
      keys(v, ['kind', 'actions', 'resources']) &&
      names(v['actions']) &&
      v['actions'].every((a) => OWNER_CODING_ACTIONS.some((action) => action === a)) &&
      v['resources'].every((r) => r.kind === 'project-worktree')
    );
  return (
    v['kind'] === 'service' &&
    keys(v, [
      'kind',
      'connectionId',
      'trustRevision',
      'tools',
      'resources',
      ...(Object.hasOwn(v, 'baselineCatalogId') ? ['baselineCatalogId'] : []),
    ]) &&
    (!Object.hasOwn(v, 'baselineCatalogId') || text(v['baselineCatalogId'])) &&
    text(v['connectionId']) &&
    revision(v['trustRevision']) &&
    validOwnerToolPolicy(v['tools']) &&
    v['resources'].every(
      (r) => r.kind !== 'project-worktree' && r.connectionId === v['connectionId'],
    )
  );
}
export function validOwnerScopeGrant(v: unknown): v is OwnerScopeGrant {
  if (
    !object(v) ||
    !keys(v, [
      'id',
      'policyVersion',
      'revision',
      'state',
      'owner',
      'subject',
      'permissions',
      'mode',
      'limits',
      'updatedAt',
    ]) ||
    !text(v['id']) ||
    v['policyVersion'] !== 2 ||
    !revision(v['revision']) ||
    (v['state'] !== 'active' && v['state'] !== 'revoked') ||
    (v['mode'] !== 'autonomous' && v['mode'] !== 'confirm') ||
    !instant(v['updatedAt'])
  )
    return false;
  const o = v['owner'],
    s = v['subject'],
    l = v['limits'],
    p = v['permissions'];
  return (
    object(o) &&
    keys(o, ['ownerId', 'issuedAt', 'source']) &&
    text(o['ownerId']) &&
    instant(o['issuedAt']) &&
    (o['source'] === 'owner-interface' || o['source'] === 'owner-migration') &&
    object(s) &&
    keys(s, ['workspaceId', 'roomId', 'botId', 'projectId', 'taskId']) &&
    text(s['workspaceId']) &&
    text(s['roomId']) &&
    text(s['botId']) &&
    (s['projectId'] === null || text(s['projectId'])) &&
    (s['taskId'] === null || text(s['taskId'])) &&
    object(l) &&
    keys(l, ['maxCalls', 'maxEffectBytes', 'expiresAt']) &&
    revision(l['maxCalls']) &&
    revision(l['maxEffectBytes']) &&
    (l['expiresAt'] === null || instant(l['expiresAt'])) &&
    Array.isArray(p) &&
    p.length > 0 &&
    p.length <= 256 &&
    authorityDenseArray(p) &&
    p.every(validOwnerPermission) &&
    authorityBoundedJson(v, 65536)
  );
}
