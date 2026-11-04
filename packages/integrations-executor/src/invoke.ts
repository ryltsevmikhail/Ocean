/**
 * Classification-free invoke path: one bounded attempt, classified by
 * `dispatch.ts`.
 *
 * The only classification produced here is `not_started`, and only from checks
 * that run before `host.execute` is called. Every adapter-internal read that
 * fails while checking membership refuses the invocation rather than
 * dispatching blind; the order is always claim (caller-side journal, before
 * this call) -> proven checks -> exactly one dispatch.
 */
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
} from '@runnets/application';
import type {
  ServicePluginInvokeOptions,
  ServicePluginInvokeOutcome,
  ServicePluginInvocation,
  ServicePluginNotStartedCode,
  ServicePluginTarget,
} from '@runnets/application';

import { classifyDispatchExit } from './dispatch.js';
import type { ExecutorHost } from './host-types.js';
import { HostOperationError } from './host-types.js';
import { canonicalJson, toServicePluginJson, utf8Bytes } from './json.js';

/** Clamp a requested deadline to the application ceiling. */
export function callDeadlineMs(requested: number | undefined): number {
  if (requested === undefined) return SERVICE_PLUGIN_CALL_DEADLINE_MS;
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(Math.floor(requested), 0), SERVICE_PLUGIN_CALL_DEADLINE_MS);
}

export function notStarted(
  invocationId: string,
  code: ServicePluginNotStartedCode,
  detail: string,
): ServicePluginInvokeOutcome {
  return { kind: 'not_started', invocationId, code, detail };
}

function isAddressable(text: string): boolean {
  return text.length > 0 && text.length <= 256;
}

/** Map a pre-dispatch host read failure to a safe refusal. */
function readFailureCode(error: HostOperationError): ServicePluginNotStartedCode {
  if (error.failure === 'timeout') return 'deadline_exhausted';
  if (error.failure === 'interrupted') return 'cancelled';
  return 'catalog_unavailable';
}

export async function runInvocation(
  host: ExecutorHost,
  target: ServicePluginTarget,
  invocation: ServicePluginInvocation,
  options: ServicePluginInvokeOptions,
): Promise<ServicePluginInvokeOutcome> {
  const invocationId = invocation.invocationId;
  const deadlineMs = callDeadlineMs(options.deadlineMs);
  if (deadlineMs <= 0)
    return notStarted(invocationId, 'deadline_exhausted', 'deadline is already exhausted');
  if (options.signal?.aborted === true)
    return notStarted(invocationId, 'cancelled', 'caller cancelled before dispatch');
  if (!isAddressable(target.integrationId) || !isAddressable(target.connectionId)) {
    return notStarted(invocationId, 'connection_unknown', 'target connection is not addressable');
  }

  const conversion = toServicePluginJson(invocation.arguments);
  if (conversion.lossy) {
    return notStarted(invocationId, 'invalid_arguments', 'arguments are not representable as JSON');
  }
  const serializedArguments = canonicalJson(conversion.value);
  if (typeof invocation.tool !== 'string' || !isAddressable(invocation.tool)) {
    return notStarted(invocationId, 'tool_unknown', 'tool name is not addressable');
  }
  if (utf8Bytes(serializedArguments) > SERVICE_PLUGIN_MAX_REQUEST_BYTES) {
    return notStarted(
      invocationId,
      'arguments_too_large',
      `arguments exceed the ${SERVICE_PLUGIN_MAX_REQUEST_BYTES}-byte request cap`,
    );
  }

  const startedAt = Date.now();
  const remaining = (): number => deadlineMs - (Date.now() - startedAt);

  let connection;
  try {
    connection = await host.getConnection(
      {
        integrationId: target.integrationId,
        connectionId: target.connectionId,
        owner: target.owner,
      },
      Math.max(1, remaining()),
    );
  } catch (error) {
    if (error instanceof HostOperationError) {
      return notStarted(
        invocationId,
        readFailureCode(error),
        'connection check failed before dispatch',
      );
    }
    throw error;
  }
  if (connection === null) {
    return notStarted(
      invocationId,
      'connection_unknown',
      'connection does not exist for this target',
    );
  }

  let tools;
  try {
    tools = await host.listTools(
      {
        integrationId: target.integrationId,
        connectionId: target.connectionId,
        owner: target.owner,
      },
      Math.max(1, remaining()),
    );
  } catch (error) {
    if (error instanceof HostOperationError) {
      return notStarted(
        invocationId,
        readFailureCode(error),
        'tool catalog read failed before dispatch',
      );
    }
    throw error;
  }
  const tool = tools.find((candidate) => candidate.name === invocation.tool);
  if (tool === undefined) {
    return notStarted(invocationId, 'tool_unknown', 'tool is not in this connection catalog');
  }
  const dispatchDeadlineMs = remaining();
  if (dispatchDeadlineMs <= 0) {
    return notStarted(
      invocationId,
      'deadline_exhausted',
      'deadline was exhausted by pre-dispatch checks',
    );
  }

  // Exactly one dispatch for this invocation. A failure after this line is
  // classified by `classifyDispatchExit`; it is never retried.
  const exit = await host.execute({
    address: tool.address,
    arguments: conversion.value,
    deadlineMs: dispatchDeadlineMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return classifyDispatchExit(invocationId, exit);
}
