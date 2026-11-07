import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { InMemoryEventLog } from '@runnets/store';
import {
  combineChatTools,
  type ChatMessage,
  type ProviderEvent,
  type ToolInvocation,
  type ToolResult,
  type TurnInput,
  type YieldedRoomSlice,
} from '@runnets/application';
type RoomHandoff = YieldedRoomSlice['handoff'];
import { provider, setup, terminal, usage } from './model-turn.js';

const calls = ['delegate', 'physical'].map((name) => ({ id: name, name, arguments: '{}' }));
export const toolRound: ProviderEvent[] = [
  ...calls.map((call) => ({ type: 'tool_call' as const, call })),
  usage,
  { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
];
export async function harness(
  mint: (proof: RoomHandoff) => ToolResult,
  firstTool = 'delegate',
  log = new InMemoryEventLog(),
) {
  const base = await setup([], undefined, log);
  const abort = new AbortController();
  const history: ChatMessage[] = [];
  const invoked: string[] = [];
  let starts = 0;
  let proof!: RoomHandoff;
  let result: (call: ToolInvocation) => Promise<ToolResult> = async () => mint(proof);
  const source = (name: string) => ({
    cleanupConfirmed: true as const,
    callDigest: (text: string) => createHash('sha256').update(text).digest('hex'),
    definitions: [{ name, description: name, parameters: {} }],
    async execute(call: ToolInvocation) {
      invoked.push(call.name);
      if (call.name === 'physical') return { isError: false, output: 'physical completed' };
      const state = await base.service.state(base.taskRunId);
      if (state.status === 'absent' || state.activeAttempt === null) throw Error('not running');
      proof = {
        turnId: 'turn_a',
        taskRunId: base.taskRunId,
        attemptId: state.activeAttempt.attemptId,
        expectedRunVersion: state.version,
        callId: call.id,
        childTaskId: 'task_b',
        deliveryId: 'delivery_b',
      };
      return result(call);
    },
  });
  const beforeComplete = vi.fn();
  const input: TurnInput = {
    ...base,
    signal: abort.signal,
    beforeComplete,
    onHistory: (batch) => history.push(...batch),
    tools: combineChatTools(source(firstTool), source('physical')),
    provider: {
      ...provider([]),
      async *stream() {
        starts++;
        yield* starts === 1
          ? toolRound.map((event) =>
              event.type === 'tool_call' && event.call.name === 'delegate'
                ? { ...event, call: { ...event.call, name: firstTool } }
                : event,
            )
          : [{ type: 'text_delta', text: 'answer' } as const, usage, terminal];
      },
    },
  };
  return {
    input,
    abort,
    history,
    invoked,
    beforeComplete,
    log,
    source,
    starts: () => starts,
    proof: () => proof,
    use: (next: (proof: RoomHandoff, call: ToolInvocation) => Promise<ToolResult> | ToolResult) => {
      result = async (call) => next(proof, call);
    },
  };
}
export async function successes(input: TurnInput) {
  return (await input.service.events(input.taskRunId)).filter(
    (event) => event.type === 'task_run.succeeded',
  );
}
