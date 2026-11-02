import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { ReviewApprovalPort } from '@runnets/application';
import type { Runtime } from '../runtime.js';
import { terminalText } from '../tui/approval.js';
import { required, type OceanArguments } from './arguments.js';

/** Only an interactive local owner can consent; redirected stdin never grants this decision. */
export function terminalReviewApproval(input: Readable, output: Writable): ReviewApprovalPort {
  return {
    async confirm(snapshot, signal) {
      if ((input as Readable & { isTTY?: boolean }).isTTY !== true || signal.aborted) return false;
      output.write(
        terminalText(
          'Run ' +
            snapshot.taskRunId +
            ' has an unknown prior outcome.\n' +
            'Continuing permits new text-only requests and possible new charges. It does not stop or retry old work.\n',
        ),
      );
      const reader = createInterface({ input, output });
      try {
        return (await reader.question('Continue text-only? [y/N] ', { signal })).trim() === 'y';
      } catch {
        return false;
      } finally {
        reader.close();
      }
    },
  };
}
/** Translate owner operations into the same reviewed application transaction used by the TUI. */
export async function runReviewCommand(
  runtime: Runtime,
  args: OceanArguments,
  requestId: string,
  approval: ReviewApprovalPort,
  signal: AbortSignal,
): Promise<unknown> {
  const operation = args.positional[0];
  const id = args.positional[1];
  if (operation === 'list') {
    const ids = await runtime.service.listTaskRuns();
    const results = [];
    for (const id of ids) {
      const result = await runtime.reviews.review('ws_ocean', id);
      if (result.ok) results.push(result.value);
    }
    return results;
  }
  if (id === undefined) throw new Error('invalid_input');
  const result =
    operation === 'show' || operation === 'review'
      ? await runtime.reviews.review('ws_ocean', id)
      : operation === 'acknowledge' && args.textOnly
        ? await runtime.reviews.acknowledge(
            {
              workspaceId: 'ws_ocean',
              taskRunId: id,
              requestId,
              reviewVersion: required(args.flags, 'review-version'),
              reason: required(args.flags, 'reason'),
            },
            approval,
            signal,
          )
        : null;
  if (result === null) throw new Error('invalid_input');
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
