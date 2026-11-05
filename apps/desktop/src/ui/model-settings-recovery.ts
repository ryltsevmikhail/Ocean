import type { LocalModelPendingRequest } from '../model-protocol.js';
import type { Command } from '../protocol.js';
/** Exact original API family and guards; legacy provider.set deliberately has no revision. */
export function recoveryCommand(request: LocalModelPendingRequest, key: string): Command {
  const operation = request.operation;
  const needsKey = 'keyWasSupplied' in operation && operation.keyWasSupplied;
  if (needsKey && !key.trim()) throw Error('key_resupply_required');
  if (!needsKey && key !== '') throw Error('invalid_request');
  const supplied = needsKey ? { key } : {};
  switch (operation.method) {
    case 'modelConnections.set':
      return { op: 'model-set', input: { ...operation.input, ...supplied } };
    case 'modelConnections.removeSavedKey':
      return { op: 'model-remove-key', input: { ...operation.input } };
    case 'provider.set':
      return { op: 'provider-set', ...operation.input, ...supplied };
    case 'provider.removeSavedKey':
      return { op: 'provider-remove-key', ...operation.input };
  }
}
export type ConnectionMutation = Extract<
  Command,
  {
    op:
      | 'model-set'
      | 'model-remove-key'
      | 'model-disconnect'
      | 'provider-set'
      | 'provider-disconnect'
      | 'provider-remove-key';
  }
>;
export interface PendingConnectionMutation {
  readonly connectionId: string;
  readonly command: ConnectionMutation;
  readonly requiresKey: boolean;
}
/** This function is only called with a keyless command captured before submission. */
export function resupply(pending: PendingConnectionMutation, key: string): ConnectionMutation {
  if (pending.requiresKey && !key.trim()) throw Error('key_resupply_required');
  if (!pending.requiresKey && key !== '') throw Error('invalid_request');
  const command = pending.command;
  if (!pending.requiresKey) return command;
  if (command.op === 'model-set') return { ...command, input: { ...command.input, key } };
  if (command.op === 'provider-set') return { ...command, key };
  throw Error('invalid_request');
}

export function keyless(command: ConnectionMutation, id: string): PendingConnectionMutation {
  if (command.op === 'model-set') {
    const { key: secret, ...input } = command.input;
    return {
      connectionId: id,
      command: { op: 'model-set', input },
      requiresKey: secret !== undefined,
    };
  }
  if (command.op === 'provider-set') {
    const { key: secret, ...input } = command;
    return { connectionId: id, command: input, requiresKey: secret !== undefined };
  }
  return { connectionId: id, command, requiresKey: false };
}
