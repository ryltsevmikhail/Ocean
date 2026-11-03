import {
  LOCAL_RUNTIME_MAX_WAIT_MS,
  isLocalRestoreInspect,
  isLocalRestoreInspection,
  isLocalRestoreSelection,
  isLocalRestoreResult,
  isLocalDecision,
  type LocalRestoreInspect,
  type LocalRestoreInspection,
  type LocalRestoreSelection,
  type LocalRestoreResult,
  type LocalDecision,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
export interface LocalRestoreClient {
  inspectRestore(input: LocalRestoreInspect): Promise<LocalRestoreInspection>;
  previewRestore(input: LocalRestoreSelection): Promise<LocalDecision>;
  restoreResult(input: LocalRestoreSelection): Promise<LocalRestoreResult>;
}
export function localRestoreClient(
  send: (method: string, input: unknown, timeoutMs?: number) => Promise<unknown>,
): LocalRestoreClient {
  return {
    async inspectRestore(input) {
      const q = validatedParams(input, isLocalRestoreInspect),
        value = await send('restore.inspect', q, LOCAL_RUNTIME_MAX_WAIT_MS);
      if (!isLocalRestoreInspection(value)) throw Error('invalid_frame');
      const {
        profileId: _p,
        snapshotId: _s,
        sourceOwnerId: _o,
        baseCommit: _b,
        treeHash: _t,
        ...selected
      } = value.selection;
      if (JSON.stringify(selected) !== JSON.stringify(q)) throw Error('invalid_frame');
      return value;
    },
    async previewRestore(input) {
      const q = validatedParams(input, isLocalRestoreSelection),
        value = await send('restore.preview', q, LOCAL_RUNTIME_MAX_WAIT_MS);
      if (
        !isLocalDecision(value) ||
        value.kind !== 'restore-rebind' ||
        value.workspaceId !== q.workspaceId ||
        value.roomId !== q.roomId
      )
        throw Error('invalid_frame');
      return value;
    },
    async restoreResult(input) {
      const q = validatedParams(input, isLocalRestoreSelection),
        value = await send('restore.result', q, LOCAL_RUNTIME_MAX_WAIT_MS);
      if (
        !isLocalRestoreResult(value) ||
        value.workspaceId !== q.workspaceId ||
        value.roomId !== q.roomId ||
        value.requestId !== q.requestId ||
        value.snapshotId !== q.snapshotId
      )
        throw Error('invalid_frame');
      return value;
    },
  };
}
