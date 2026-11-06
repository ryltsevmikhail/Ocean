/**
 * Application turn orchestration contracts shared by runtime hosts.
 *
 * The engine is host-neutral: the ACP agent and the TUI both call `runTurn`
 * with their own update sink and cancellation signal.
 */

import type { RoomHandoff } from './room-slice-handoff.js';
import type { ToolService } from './tools.js';
import type { TaskRunService } from './service.js';
import type { TurnUpdate, StopReason } from './turn-update.js';
import type { Clock } from './ports.js';
import type { ModelActivationSnapshot, TaskRunId } from '@runnets/domain';
import type { ChatMessage, ProviderPort } from './provider.js';

export interface TurnInput {
  readonly activation?: ModelActivationSnapshot;
  readonly clock?: Clock;
  readonly beforeComplete?: (
    text: string,
    stopReason: 'end_turn' | 'max_tokens',
  ) => void | Promise<void>;
  readonly tools?:
    (Pick<ToolService, 'definitions' | 'execute'> & { readonly instructions?: string }) | undefined;
  readonly maxModelRequests?: number;
  readonly onHistory?: (messages: readonly ChatMessage[]) => void;
  readonly service: TaskRunService;
  /** Resolved provider, or null when the host has no credentials configured. */
  readonly provider: ProviderPort | null;
  readonly taskRunId: TaskRunId;
  readonly model: string;
  /** Conversation history ending with the current user message. */
  readonly messages: readonly ChatMessage[];
  readonly signal: AbortSignal;
  readonly emit: (update: TurnUpdate) => void;
}

export type TurnOutcome =
  | { readonly kind: 'completed'; readonly stopReason: StopReason; readonly text: string }
  | { readonly kind: 'uncertain'; readonly stopReason: 'refusal'; readonly text: string }
  | { readonly kind: 'failed'; readonly stopReason: StopReason; readonly text: string }
  | { readonly kind: 'cancelled'; readonly stopReason: 'cancelled'; readonly text: string };

export type YieldedRoomSlice = { readonly kind: 'yielded'; readonly handoff: RoomHandoff };
