/**
 * Agent Client Protocol (ACP) v1 wire contract — the agent side.
 *
 * This is the boundary an external desktop client speaks to: it spawns the
 * runtime CLI as a child process and exchanges newline-delimited JSON-RPC over
 * stdio. Only the surface that clients actually call is modelled; every schema
 * change here is a compatibility decision for out-of-repo consumers.
 *
 * Reference: https://agentclientprotocol.com
 */

import type { JsonRpcId } from './jsonrpc.js';

export const ACP_PROTOCOL_VERSION = 1;

export interface Implementation {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

export interface FileSystemCapabilities {
  readonly readTextFile?: boolean;
  readonly writeTextFile?: boolean;
}

export interface ClientCapabilities {
  readonly fs?: FileSystemCapabilities;
  readonly terminal?: boolean;
  readonly _meta?: Record<string, unknown>;
}

export interface InitializeParams {
  readonly protocolVersion: number;
  readonly clientCapabilities?: ClientCapabilities;
  readonly clientInfo?: Implementation;
}

export interface PromptCapabilities {
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly embeddedContext?: boolean;
}

export interface SessionCapabilities {
  readonly close?: boolean;
  readonly load?: boolean;
  readonly resume?: boolean;
}

export interface AgentCapabilities {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: PromptCapabilities;
  readonly sessionCapabilities?: SessionCapabilities;
}

export interface AuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
}

/** Model catalog shared by the initialize and session responses. */
export interface ModelState {
  readonly currentModelId?: string;
  readonly availableModels: readonly ModelInfo[];
}

export interface InitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities?: AgentCapabilities;
  readonly agentInfo?: Implementation;
  readonly authMethods?: readonly AuthMethod[];
  readonly models?: ModelState;
}

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name?: string;
      readonly mimeType?: string;
    }
  | {
      readonly type: 'resource';
      readonly resource: {
        readonly uri: string;
        readonly mimeType?: string;
        readonly text?: string;
      };
    };

export interface McpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: readonly { readonly name: string; readonly value: string }[];
}

export interface McpServerHttp {
  readonly name: string;
  readonly url: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
}

export type McpServer = McpServerStdio | McpServerHttp;

export interface NewSessionParams {
  readonly cwd: string;
  readonly mcpServers?: readonly McpServer[];
  /** Client-selected model id; omitted means "agent default". */
  readonly model?: string;
}

export interface NewSessionResult {
  readonly sessionId: string;
  readonly models?: ModelState;
}

export interface PromptParams {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
}

export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export interface PromptResult {
  readonly stopReason: StopReason;
}

export interface CancelParams {
  readonly sessionId: string;
}

export interface LoadSessionParams extends NewSessionParams {
  readonly sessionId: string;
}

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallContentText {
  readonly type: 'content';
  readonly content: ContentBlock;
}

export interface ToolCallContentDiff {
  readonly type: 'diff';
  readonly path: string;
  readonly oldText?: string;
  readonly newText: string;
}

export interface ToolCallContentTerminal {
  readonly type: 'terminal';
  readonly terminalId: string;
}

export type ToolCallContent = ToolCallContentText | ToolCallContentDiff | ToolCallContentTerminal;

export interface ToolCallLocation {
  readonly path: string;
  readonly line?: number;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
  readonly content?: readonly ToolCallContent[];
  readonly locations?: readonly ToolCallLocation[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface PlanEntry {
  readonly content: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly status: 'pending' | 'in_progress' | 'completed';
}

/** Discriminated union of every `session/update` payload the client handles. */
export type SessionUpdate =
  | { readonly sessionUpdate: 'user_message_chunk'; readonly content: ContentBlock }
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: ContentBlock }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: ContentBlock }
  | ({ readonly sessionUpdate: 'tool_call' } & ToolCall)
  | {
      readonly sessionUpdate: 'tool_call_update';
      readonly toolCallId: string;
      readonly status?: ToolCallStatus;
      readonly content?: readonly ToolCallContent[];
    }
  | { readonly sessionUpdate: 'plan'; readonly entries: readonly PlanEntry[] }
  | { readonly sessionUpdate: 'config_option_update'; readonly configOptions: unknown }
  | { readonly sessionUpdate: 'current_mode_update'; readonly currentModeId: string };

export interface SessionUpdateParams {
  readonly sessionId: string;
  readonly update: SessionUpdate;
}

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface RequestPermissionParams {
  readonly sessionId: string;
  readonly toolCall: ToolCall;
  readonly options: readonly PermissionOption[];
}

export type PermissionOutcome =
  { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' };

export interface RequestPermissionResult {
  readonly outcome: PermissionOutcome;
}

export interface ReadTextFileParams {
  readonly sessionId: string;
  readonly path: string;
  readonly line?: number;
  readonly limit?: number;
}

export interface ReadTextFileResult {
  readonly content: string;
  readonly truncated?: boolean;
}

export interface WriteTextFileParams {
  readonly sessionId: string;
  readonly path: string;
  readonly content: string;
}

export type WriteTextFileResult = Record<string, never>;

/** Correlates an outbound request with the turn that caused it. */
export interface AgentRequestContext {
  readonly requestId: JsonRpcId;
  readonly sessionId: string;
}
