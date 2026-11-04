/**
 * Explicit `/broadcast` prompt grammar for the TUI.
 *
 * Only exactly `/broadcast`, `/broadcast show` and `/broadcast
 * continue|abandon BATCH_ID REVISION` are actions. Any other text after
 * `/broadcast ` is a normal broadcast message, so a question that happens to
 * start with "continue", "abandon" or "show" is never turned into a vote.
 */
export type BroadcastPrompt =
  | { readonly kind: 'show' }
  | {
      readonly kind: 'vote';
      readonly action: 'continue' | 'abandon';
      readonly batchId: string;
      readonly expectedRevision: number;
    }
  | { readonly kind: 'submit'; readonly text: string };

const PREFIX = '/broadcast';
export function parseBroadcastPrompt(prompt: string): BroadcastPrompt | null {
  if (prompt !== PREFIX && !prompt.startsWith(PREFIX + ' ')) return null;
  const text = prompt.slice(PREFIX.length).trim();
  if (text === '' || text === 'show') return { kind: 'show' };
  const vote = /^(continue|abandon) (\S{1,128}) (\d{1,9})$/.exec(text);
  if (vote) {
    const expectedRevision = Number(vote[3]);
    if (Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)
      return {
        kind: 'vote',
        action: vote[1] as 'continue' | 'abandon',
        batchId: vote[2]!,
        expectedRevision,
      };
  }
  return { kind: 'submit', text };
}
