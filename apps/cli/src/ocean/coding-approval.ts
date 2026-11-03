import { createInterface } from 'node:readline/promises';
import type { CodingApprovalOwnerPort } from '@runnets/application';
import { terminalText } from '../tui/text.js';

/** Host-only interactive approval. Redirected input cannot approve operations. */
export function codingApprovalOwner(signal: AbortSignal): CodingApprovalOwnerPort {
  return {
    decide: async (approval) => {
      if (signal.aborted || process.stdin.isTTY !== true || process.stderr.isTTY !== true)
        return 'cancel';
      process.stderr.write(
        terminalText(JSON.stringify(approval.binding, null, 2) + '\n' + approval.preview) + '\n',
      );
      const reader = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      try {
        const answer = await reader.question('Allow this operation once? [y/N] ', { signal });
        return answer === 'y' ? 'allow-once' : 'deny';
      } catch {
        return 'cancel';
      } finally {
        reader.close();
      }
    },
  };
}
