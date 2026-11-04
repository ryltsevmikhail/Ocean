/** Enforce Ocean's dispatch contract below SDK-internal retry/catalog recovery. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutorDispatchExit } from './dispatch.js';

interface Dispatch {
  sent: boolean;
  status: number | null;
  blocked: boolean;
}

async function rpcMethod(
  input: string | Request | URL,
  init?: RequestInit,
): Promise<string | null> {
  const body = init?.body;
  const text =
    typeof body === 'string'
      ? body
      : ArrayBuffer.isView(body) || body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : input instanceof Request
          ? await input.clone().text()
          : '';
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' &&
      value !== null &&
      'method' in value &&
      typeof value.method === 'string'
      ? value.method
      : null;
  } catch {
    return null;
  }
}

export function createMcpDispatchGuard(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
  const dispatches = new AsyncLocalStorage<Dispatch>();
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const dispatch = dispatches.getStore();
    const method = dispatch === undefined ? null : await rpcMethod(input, init);
    if (dispatch !== undefined) {
      if (
        method === 'tools/list' ||
        method === 'server/discover' ||
        (method === 'tools/call' && (dispatch.sent || dispatch.blocked))
      ) {
        dispatch.blocked = true;
        throw new Error('mcp_dispatch_recovery_refused');
      }
      if (method === 'tools/call') dispatch.sent = true;
    }
    const response = await fetchImpl(input, init);
    if (dispatch !== undefined && method === 'tools/call') dispatch.status = response.status;
    return response;
  };
  return {
    fetch: guardedFetch,
    async run(work: () => Promise<ExecutorDispatchExit>): Promise<ExecutorDispatchExit> {
      const dispatch: Dispatch = { sent: false, status: null, blocked: false };
      const exit = await dispatches.run(dispatch, work);
      if (!dispatch.blocked) return exit;
      if (!dispatch.sent)
        return { ok: false, outcome: 'not_started', tag: 'catalog_discovery_required' };
      if (dispatch.status !== null && dispatch.status >= 400 && dispatch.status < 500) {
        return {
          ok: true,
          value: {
            ok: false,
            error: {
              code: 'mcp_tool_error',
              status: dispatch.status,
              message:
                'Upstream refused the request; SDK recovery was blocked without repeating it.',
            },
          },
        };
      }
      // A prior 5xx, lost reply or incomplete success remains unknown, never not_started.
      return { ok: false, outcome: 'failure', tag: 'mcp_dispatch_recovery_refused' };
    },
  };
}
