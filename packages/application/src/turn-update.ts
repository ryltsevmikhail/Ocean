/** Host-neutral updates emitted by orchestration; transports map them to client contracts. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
type Text = { readonly type: 'text'; readonly text: string };
export type TurnUpdate =
  | {
      readonly sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk';
      readonly content: Text;
    }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string }
  | {
      readonly sessionUpdate: 'tool_call';
      readonly toolCallId: string;
      readonly title: string;
      readonly kind: 'execute' | 'read' | 'search' | 'edit';
      readonly status: 'pending';
    }
  | {
      readonly sessionUpdate: 'tool_call_update';
      readonly toolCallId: string;
      readonly status: 'failed' | 'completed';
      readonly content: readonly { readonly type: 'content'; readonly content: Text }[];
    };
