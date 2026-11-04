import { randomUUID } from 'node:crypto';
import type { LocalRoomScope, LocalTurnRequest } from '@runnets/contracts';
import type { RoomConnection } from './room-connection.js';

// These admission refusals arrive before a new operation commits. Other failures leave the binding held.
const refused = new Set([
  'invalid_input',
  'invalid_params',
  'request_conflict',
  'workspace_conflict',
  'unknown_bot',
  'not_member',
  'unknown_room',
  'room_busy',
  'recovery_required',
  'provider_unavailable',
  'context_limit',
  'runtime_draining',
  'model_image_unsupported',
  'image_unavailable',
  'image_too_large',
  'request_too_large',
]);
export class RoomSubmission {
  readonly #connection: RoomConnection;
  readonly #scope: LocalRoomScope;
  readonly #taskId: string | undefined;
  #pending: LocalTurnRequest | null = null;

  constructor(connection: RoomConnection, scope: LocalRoomScope, taskId?: string) {
    this.#connection = connection;
    this.#scope = scope;
    this.#taskId = taskId;
  }
  async submit(text: string) {
    if (this.#pending && this.#pending.text !== text)
      throw Error(
        'Acknowledgement unknown. Retry the original message or reopen the room to inspect history.',
      );
    const request = (this.#pending ??= Object.freeze({
      ...this.#scope,
      text,
      requestId: randomUUID(),
      ...(this.#taskId ? { taskId: this.#taskId } : {}),
    }));
    try {
      const receipt = await this.#connection.withClient((c) => c.submit(request));
      this.#pending = null;
      return receipt;
    } catch (e) {
      if (e instanceof Error && refused.has(e.message)) this.#pending = null;
      throw e;
    }
  }
}
