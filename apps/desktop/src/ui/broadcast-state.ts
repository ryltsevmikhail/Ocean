import { computed, ref } from 'vue';
import type { BroadcastBatch } from '../protocol.js';
import { call } from './bridge.js';
import { explain } from './dom.js';
import { broadcastBlocksNewTurns, broadcastPaused } from './broadcast-text.js';

/** Shared batch state for the open room; the runtime is the only source of truth. */
export const broadcastBatch = ref<BroadcastBatch | null>(null);
export const broadcastBusy = ref(false);
export const broadcastMessage = ref('');
export const broadcastError = ref(false);
export const broadcastCode = ref('');
export const broadcastIsPaused = computed(() => broadcastPaused(broadcastBatch.value));
export const broadcastBlocksSending = computed(() => broadcastBlocksNewTurns(broadcastBatch.value));
export async function readBroadcast(room: string): Promise<void> {
  try {
    const batches = await call({ op: 'broadcast-list', room });
    broadcastBatch.value = batches[0] ?? null;
  } catch {
    // A missing runtime or a closed room simply has no batch panel; history stays usable.
  }
}
export function resetBroadcastState(): void {
  pending.clear();
  broadcastBatch.value = null;
  broadcastBusy.value = false;
  broadcastMessage.value = '';
  broadcastError.value = false;
  broadcastCode.value = '';
}
function fail(error: unknown): void {
  broadcastCode.value = error instanceof Error ? error.message : String(error);
  broadcastMessage.value = explain(error);
  broadcastError.value = true;
}
async function vote(
  action: 'broadcast-continue' | 'broadcast-abandon',
  success: string,
): Promise<void> {
  const batch = broadcastBatch.value;
  if (batch === null || broadcastBusy.value) return;
  broadcastBusy.value = true;
  broadcastMessage.value = '';
  broadcastError.value = false;
  broadcastCode.value = '';
  try {
    broadcastBatch.value = await call({
      op: action,
      room: batch.roomId,
      batchId: batch.id,
      expectedRevision: batch.revision,
    });
    broadcastMessage.value = success;
  } catch (error) {
    fail(error);
  } finally {
    broadcastBusy.value = false;
  }
}
/** Submit through the runtime; the returned batch is the authoritative receipt. */
export async function submitBroadcast(input: {
  readonly room: string;
  readonly requestId: string;
  readonly text: string;
  readonly attachments: readonly string[];
}): Promise<BroadcastBatch> {
  const created = await call({
    op: 'broadcast',
    room: input.room,
    requestId: input.requestId,
    text: input.text,
    ...(input.attachments.length === 0 ? {} : { attachments: [...input.attachments] }),
  });
  broadcastBatch.value = created;
  return created;
}
const pending = new Map<string, { requestId: string; text: string; attachments: string[] }>();
/** Admission may have committed although the reply was lost: retry the same request id. */
export function pendingBroadcast(room: string) {
  return pending.get(room);
}
export type BroadcastSendOutcome =
  | { readonly kind: 'submitted'; readonly batch: BroadcastBatch }
  | { readonly kind: 'refused'; readonly code: string; readonly retried: boolean }
  | { readonly kind: 'unconfirmed'; readonly requestId: string };
export async function sendOwnedBroadcast(input: {
  readonly room: string;
  readonly text: string;
  readonly attachments: readonly string[];
}): Promise<BroadcastSendOutcome> {
  const original = pending.get(input.room);
  const command = original ?? {
    requestId: crypto.randomUUID(),
    text: input.text,
    attachments: [...input.attachments],
  };
  try {
    const batch = await submitBroadcast({ room: input.room, ...command });
    pending.delete(input.room);
    return { kind: 'submitted', batch };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    const refused = [
      'invalid_input',
      'invalid_params',
      'request_conflict',
      'workspace_conflict',
      'unknown_room',
      'batch_open',
      'recovery_required',
      'room_busy',
      'runtime_draining',
      'provider_unavailable',
      'model_image_unsupported',
      'image_unavailable',
      'image_too_large',
      'request_too_large',
    ].includes(code);
    if (refused) {
      pending.delete(input.room);
      return { kind: 'refused', code, retried: original !== undefined };
    }
    pending.set(input.room, command);
    return { kind: 'unconfirmed', requestId: command.requestId };
  }
}
export function continueBroadcast(): Promise<void> {
  return vote('broadcast-continue', 'Рассылка продолжена с неотправленных участников.');
}
export function abandonBroadcast(): Promise<void> {
  return vote('broadcast-abandon', 'Рассылка оставлена: неотправленные участники не получат ход.');
}
