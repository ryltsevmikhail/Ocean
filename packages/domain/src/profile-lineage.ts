export type ProfileIntentOutputKind =
  'materialization' | 'git-administration' | 'git-reference' | 'desktop' | 'registration';
export interface ProfileLineageIntent {
  readonly requestId: string;
  readonly recordHash: string;
  readonly state: 'preview' | 'confirmed' | 'preparing' | 'ready' | 'held' | 'refused';
  readonly outputs: readonly {
    readonly kind: ProfileIntentOutputKind;
    readonly presence: 'absent' | 'captured';
    readonly manifestHash: string | null;
  }[];
}
export interface ProfileBackupLineage {
  readonly format: 1;
  readonly parentSnapshotId: string;
  readonly codingInventory: string;
  readonly desktopInventory: string;
  readonly recordsHash: string;
  readonly tasks: readonly { readonly taskId: string; readonly source: 'live' | 'parent' }[];
  readonly desktopSource: 'live' | 'parent';
  readonly intents: readonly ProfileLineageIntent[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0');
export const PROFILE_INTENT_OUTPUTS: readonly ProfileIntentOutputKind[] = [
  'materialization',
  'git-administration',
  'git-reference',
  'desktop',
  'registration',
];
export function validProfileBackupLineage(v: unknown): v is ProfileBackupLineage {
  if (
    !object(v) ||
    Object.keys(v).sort().join() !==
      'codingInventory,desktopInventory,desktopSource,format,intents,parentSnapshotId,recordsHash,tasks' ||
    v['format'] !== 1 ||
    !['parentSnapshotId', 'codingInventory', 'desktopInventory', 'recordsHash'].every((k) =>
      sha(v[k]),
    ) ||
    !['live', 'parent'].includes(String(v['desktopSource'])) ||
    !Array.isArray(v['tasks']) ||
    v['tasks'].length > 1000 ||
    !Array.isArray(v['intents']) ||
    v['intents'].length > 1000
  )
    return false;
  const tasks = v['tasks'] as readonly unknown[];
  if (
    !tasks.every(
      (t) =>
        object(t) &&
        Object.keys(t).sort().join() === 'source,taskId' &&
        id(t['taskId']) &&
        ['live', 'parent'].includes(String(t['source'])),
    ) ||
    new Set(tasks.map((t) => (object(t) ? String(t['taskId']) : ''))).size !== tasks.length
  )
    return false;
  const intents = v['intents'] as readonly unknown[];
  return (
    intents.every(
      (r) =>
        object(r) &&
        Object.keys(r).sort().join() === 'outputs,recordHash,requestId,state' &&
        id(r['requestId']) &&
        sha(r['recordHash']) &&
        ['preview', 'confirmed', 'preparing', 'ready', 'held', 'refused'].includes(
          String(r['state']),
        ) &&
        Array.isArray(r['outputs']) &&
        r['outputs'].length === 5 &&
        (r['outputs'] as readonly unknown[]).every(
          (o, index) =>
            object(o) &&
            Object.keys(o).sort().join() === 'kind,manifestHash,presence' &&
            o['kind'] === PROFILE_INTENT_OUTPUTS[index] &&
            (o['presence'] === 'absent'
              ? o['manifestHash'] === null
              : o['presence'] === 'captured' && sha(o['manifestHash'])),
        ),
    ) &&
    new Set(intents.map((r) => (object(r) ? String(r['requestId']) : ''))).size === intents.length
  );
}
