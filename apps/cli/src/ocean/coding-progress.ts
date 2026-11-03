import type { Writable } from 'node:stream';
import type { TurnUpdate } from '@runnets/application';
import { terminalText } from '../tui/text.js';
/** Trusted tool progress is local host output and never appended to shared room history. */
export function codingProgress(update: TurnUpdate, output: Writable): void {
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    output.write(terminalText(JSON.stringify(update)) + '\n');
}
