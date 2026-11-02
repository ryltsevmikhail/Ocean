/**
 * JSON-RPC 2.0 wire types.
 *
 * The transport is newline-delimited JSON over stdio. These types describe the
 * frames only; correlation, timeouts and error mapping belong to the host.
 */

export const JSONRPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccess<TResult = unknown> {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: TResult;
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Standard JSON-RPC error codes used by the server. */
export const JSONRPC_ERROR = {
  parse: -32_700,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  invalidParams: -32_602,
  internal: -32_603,
  /** Application-defined range; the ACP agent uses these for domain refusals. */
  application: -32_000,
} as const;

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message && 'method' in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !('id' in message) && 'method' in message;
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message) && 'id' in message;
}
