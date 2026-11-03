import {
  isLocalFinalizationCard,
  isLocalFinalizationResult,
  isLocalFinalizationSelection,
  type LocalFinalizationResult,
  type LocalFinalizationSelection,
  type LocalDecision,
} from '@runnets/contracts';
import { validatedParams } from './local-room-client.js';
export interface LocalFinalizationClient {
  previewFinalization(input: LocalFinalizationSelection): Promise<LocalDecision>;
  finalizationResult(input: LocalFinalizationSelection): Promise<LocalFinalizationResult>;
}
export function localFinalizationClient(
  send: (method: string, input: unknown) => Promise<unknown>,
): LocalFinalizationClient {
  return {
    async previewFinalization(input) {
      const q = validatedParams(input, isLocalFinalizationSelection),
        value = await send('coding.finalize.preview', q);
      if (
        !isLocalFinalizationCard(value) ||
        value.workspaceId !== q.workspaceId ||
        value.roomId !== q.roomId ||
        value.runId !== 'finalize-' + q.requestId
      )
        throw Error('invalid_frame');
      return value;
    },
    async finalizationResult(input) {
      const q = validatedParams(input, isLocalFinalizationSelection),
        value = await send('coding.finalize.result', q);
      if (
        !isLocalFinalizationResult(value) ||
        value.workspaceId !== q.workspaceId ||
        value.roomId !== q.roomId ||
        value.requestId !== q.requestId ||
        value.taskId !== q.taskId
      )
        throw Error('invalid_frame');
      return value;
    },
  };
}
