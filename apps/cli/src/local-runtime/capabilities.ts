import {
  LOCAL_DECISION_METHODS,
  LOCAL_FINALIZATION_METHODS,
  LOCAL_PROVIDER_METHODS,
  LOCAL_RESTORE_METHODS,
  LOCAL_BROADCAST_METHODS,
  LOCAL_ROOM_METHODS,
  PROFILE_METHODS,
} from '@runnets/contracts';

/** Authenticated method capability list; order starts with the identity probe contract. */
export function runtimeCapabilities(restore: boolean): readonly string[] {
  return [
    'status',
    'stop',
    'turns.submit',
    'desktop.assets',
    'receipts.get',
    'runs.get',
    ...LOCAL_ROOM_METHODS,
    ...LOCAL_DECISION_METHODS,
    'coding.panel',
    ...PROFILE_METHODS,
    ...LOCAL_RESTORE_METHODS,
    ...LOCAL_PROVIDER_METHODS,
    ...LOCAL_BROADCAST_METHODS,
    ...(restore ? [] : LOCAL_FINALIZATION_METHODS),
    ...(restore ? ['restore.maintenance'] : []),
  ];
}
