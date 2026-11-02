/**
 * Shared terminal-UI value types.
 *
 * Sizes and stream lines are plain data so the layout renderer stays a pure
 * function of them: no terminal capability is consulted while rendering.
 */

export interface Size {
  readonly columns: number;
  readonly rows: number;
}

export type StreamKind = 'text' | 'thought' | 'user' | 'tool';

/** One accumulated provider delta line shown in the live stream panel. */
export interface StreamLine {
  readonly kind: StreamKind;
  readonly text: string;
  readonly label?: string;
  readonly id?: string;
  readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed';
}
