import {
  authorityKeys as keys,
  authorityObject as object,
  authorityText as text,
} from './service-authority-validation.js';
import { validPluginRepository } from './plugin-catalog.js';

/** Permission intent; account/repository strings alone are never verified facts. */
export type OwnerResourceScope =
  | { readonly kind: 'connection'; readonly connectionId: string }
  | { readonly kind: 'account'; readonly connectionId: string; readonly accountId: string }
  | {
      readonly kind: 'github-repository';
      readonly connectionId: string;
      readonly accountId: string;
      readonly repository: string;
    }
  | {
      readonly kind: 'project-worktree';
      readonly projectId: string;
      readonly worktreeId: string | null;
    };
/** Absent/legacy journal scope must be normalized to the global unknown by the caller. */
export type EffectResourceScope =
  | { readonly kind: 'legacy-global-unknown' }
  | { readonly kind: 'resources'; readonly resources: readonly OwnerResourceScope[] };
export function validOwnerResourceScope(v: unknown): v is OwnerResourceScope {
  if (!object(v)) return false;
  switch (v['kind']) {
    case 'connection':
      return keys(v, ['kind', 'connectionId']) && text(v['connectionId']);
    case 'account':
      return (
        keys(v, ['kind', 'connectionId', 'accountId']) &&
        text(v['connectionId']) &&
        text(v['accountId'])
      );
    case 'github-repository':
      return (
        keys(v, ['kind', 'connectionId', 'accountId', 'repository']) &&
        text(v['connectionId']) &&
        text(v['accountId']) &&
        validPluginRepository(v['repository'])
      );
    case 'project-worktree':
      return (
        keys(v, ['kind', 'projectId', 'worktreeId']) &&
        text(v['projectId']) &&
        (v['worktreeId'] === null || text(v['worktreeId']))
      );
    default:
      return false;
  }
}
export function validOwnerResources(v: unknown): v is readonly OwnerResourceScope[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 256 &&
    v.every(validOwnerResourceScope) &&
    new Set(v.map((s) => JSON.stringify(s))).size === v.length
  );
}
export function validEffectResourceScope(v: unknown): v is EffectResourceScope {
  return (
    object(v) &&
    ((v['kind'] === 'legacy-global-unknown' && keys(v, ['kind'])) ||
      (v['kind'] === 'resources' &&
        keys(v, ['kind', 'resources']) &&
        validOwnerResources(v['resources'])))
  );
}
