/** Declared model metadata; unknown limits stay unknown. */
export interface ModelCapabilities {
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly inputModalities: readonly ('text' | 'image')[];
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly usage: 'reported' | 'optional' | 'unavailable';
}
