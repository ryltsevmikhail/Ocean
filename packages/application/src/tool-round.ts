import type { ChatMessage, ToolCall } from './provider.js';
import type { ToolResult } from './tools.js';
import type { TurnInput } from './types.js';

/** Execute serially after admission; one uncertain outcome stops the turn without a replay. */
export async function executeTools(
  input: TurnInput,
  calls: readonly ToolCall[],
  round: number,
  attemptId: string,
  messages: ChatMessage[],
): Promise<{ readonly uncertain: boolean }> {
  if (input.tools === undefined) return { uncertain: false };
  const skipped = (from: number, reason: string): void => {
    for (const call of calls.slice(from))
      messages.push({ role: 'tool', toolCallId: call.id, content: `Not executed: ${reason}` });
  };
  for (const [index, call] of calls.entries()) {
    if (input.signal.aborted) {
      skipped(index, 'turn cancelled');
      return { uncertain: false };
    }
    const id = `${attemptId}_r${round}_${call.id}`;
    input.emit({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: call.name,
      kind:
        call.name === 'run_command'
          ? 'execute'
          : call.name === 'read_file'
            ? 'read'
            : call.name === 'list_files'
              ? 'search'
              : 'edit',
      status: 'pending',
    });
    let result: ToolResult;
    try {
      result = await input.tools.execute({ ...call, id }, input.signal, {
        taskRunId: input.taskRunId,
        attemptId,
      });
    } catch {
      // A rejected execution promise cannot establish that no effect occurred.
      result = { isError: true, uncertain: true, output: 'tool outcome uncertain' };
    }
    input.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: result.isError || result.uncertain === true ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text: result.output } }],
    });
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content:
        result.output +
        (result.uncertain === true
          ? '\nOutcome uncertain; do not repeat automatically. Inspect effects first.'
          : ''),
    });
    if (result.uncertain === true) {
      skipped(index + 1, 'prior tool outcome uncertain');
      return { uncertain: true };
    }
  }
  return { uncertain: false };
}
