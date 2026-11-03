import { localId } from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';
import { bindingDigest } from './local-runtime-decisions.js';
export const LOCAL_RESTORE_METHODS = [
  'restore.inspect',
  'restore.preview',
  'restore.result',
] as const;
export interface LocalRestorePolicy {
  readonly version: 1;
  readonly devCapabilities: readonly (
    'project_read' | 'propose_write' | 'run_test_preset' | 'changeset_read'
  )[];
  readonly reviewCapabilities: readonly ['changeset_read'];
  readonly testPresets: readonly {
    readonly id: string;
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: '.';
  }[];
}
export interface LocalRestoreInspect {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly policy: LocalRestorePolicy;
}
export interface LocalRestoreSelection extends LocalRestoreInspect {
  readonly profileId: string;
  readonly snapshotId: string;
  readonly sourceOwnerId: string;
  readonly baseCommit: string;
  readonly treeHash: string;
}
export interface LocalRestoreHold {
  readonly id: string;
  readonly kind: string;
  readonly outcome: string;
  readonly scope: 'global' | 'operation';
}
export interface LocalRestoreObservation {
  readonly changesetHash: string;
  readonly comparison: 'before' | 'after' | 'mixed' | 'conflicting' | 'unknown';
  readonly scope: 'selected-project-only';
  readonly settlesEffect: false;
}
export interface LocalRestoreInspection {
  readonly selection: LocalRestoreSelection;
  readonly holds: readonly LocalRestoreHold[];
  readonly observations: readonly LocalRestoreObservation[];
  readonly postSnapshotInterval: 'unknown-never-replayed';
}
export interface LocalRestoreResult {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly epochId: string;
  readonly successorTaskId: string;
  readonly bindingDigest: string;
  readonly state: 'preview' | 'confirmed' | 'preparing' | 'ready' | 'held' | 'refused';
  readonly reason: string | null;
}
const text = (s: unknown, max = 4096): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= max && !s.includes('\0');
const fields = ['workspaceId', 'roomId', 'requestId', 'taskId', 'projectRoot', 'policy'];
const capabilities = [
  'project_read',
  'propose_write',
  'run_test_preset',
  'changeset_read',
] as const;
function policy(value: unknown): value is LocalRestorePolicy {
  if (!localRuntimeRecord(value)) return false;
  const dev = value['devCapabilities'],
    presets = value['testPresets'];
  return (
    Object.keys(value).sort().join() === 'devCapabilities,reviewCapabilities,testPresets,version' &&
    value['version'] === 1 &&
    Array.isArray(dev) &&
    dev.length <= 4 &&
    dev.every(
      (c: unknown) => typeof c === 'string' && (capabilities as readonly string[]).includes(c),
    ) &&
    JSON.stringify(value['reviewCapabilities']) === '["changeset_read"]' &&
    Array.isArray(presets) &&
    presets.length <= 20 &&
    presets.every(
      (p: unknown) =>
        localRuntimeRecord(p) &&
        Object.keys(p).sort().join() === 'args,cwd,id,program' &&
        localId(p['id']) &&
        text(p['program']) &&
        p['cwd'] === '.' &&
        Array.isArray(p['args']) &&
        p['args'].length <= 64 &&
        p['args'].every(
          (a: unknown) => typeof a === 'string' && a.length <= 4096 && !a.includes('\0'),
        ),
    )
  );
}
export function isLocalRestoreInspect(value: unknown): value is LocalRestoreInspect {
  return (
    localRuntimeRecord(value) &&
    Object.keys(value).every((k) => fields.includes(k)) &&
    fields.slice(0, 4).every((k) => localId(value[k])) &&
    text(value['projectRoot']) &&
    value['projectRoot'].startsWith('/') &&
    policy(value['policy'])
  );
}
export function isLocalRestoreSelection(value: unknown): value is LocalRestoreSelection {
  if (!localRuntimeRecord(value)) return false;
  const { profileId, snapshotId, sourceOwnerId, baseCommit, treeHash, ...input } = value;
  return (
    isLocalRestoreInspect(input) &&
    bindingDigest(profileId) &&
    bindingDigest(snapshotId) &&
    bindingDigest(treeHash) &&
    text(sourceOwnerId) &&
    typeof baseCommit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(baseCommit)
  );
}
export function isLocalRestoreInspection(value: unknown): value is LocalRestoreInspection {
  return (
    localRuntimeRecord(value) &&
    isLocalRestoreSelection(value['selection']) &&
    value['postSnapshotInterval'] === 'unknown-never-replayed' &&
    Array.isArray(value['holds']) &&
    value['holds'].length <= 10000 &&
    value['holds'].every(
      (h) =>
        localRuntimeRecord(h) &&
        ['id', 'kind', 'outcome'].every((k) => text(h[k])) &&
        ['global', 'operation'].includes(String(h['scope'])),
    ) &&
    Array.isArray(value['observations']) &&
    value['observations'].length <= 10000 &&
    value['observations'].every(
      (o) =>
        localRuntimeRecord(o) &&
        bindingDigest(o['changesetHash']) &&
        o['scope'] === 'selected-project-only' &&
        o['settlesEffect'] === false &&
        ['before', 'after', 'mixed', 'conflicting', 'unknown'].includes(String(o['comparison'])),
    )
  );
}
export function isLocalRestoreResult(value: unknown): value is LocalRestoreResult {
  return (
    localRuntimeRecord(value) &&
    ['workspaceId', 'roomId', 'requestId', 'epochId', 'successorTaskId'].every((k) =>
      localId(value[k]),
    ) &&
    bindingDigest(value['snapshotId']) &&
    bindingDigest(value['bindingDigest']) &&
    ['preview', 'confirmed', 'preparing', 'ready', 'held', 'refused'].includes(
      String(value['state']),
    ) &&
    (value['reason'] === null || text(value['reason']))
  );
}
