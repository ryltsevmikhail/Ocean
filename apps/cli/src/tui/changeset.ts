import type { RunBookPort, ScreenEntry } from './runs.js';
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unexpected error';
}
/** Reading a panel never dispatches a turn or supplies approval authority. */
export async function refreshChangeset(
  book: RunBookPort,
  entry: ScreenEntry | undefined,
  redraw: () => void,
): Promise<void> {
  if (!entry) return;
  entry.codingLines = ['Loading changeset…'];
  redraw();
  try {
    if (book.loadChangeset) await book.loadChangeset(entry);
    else entry.codingLines = ['No coding changeset. Open a task-bound room to inspect changes.'];
  } catch (error) {
    entry.codingLines = ['Changeset unavailable: ' + messageOf(error)];
  }
  redraw();
}
