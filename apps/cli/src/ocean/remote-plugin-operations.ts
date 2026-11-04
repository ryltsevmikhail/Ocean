/**
 * Room TUI `/plugin operations|operation|acknowledge` commands.
 *
 * Split from the main plugin command module to keep each host file inside the
 * 300-line source bound. Rendering only: the runtime owns the durable journal.
 */

import type { LocalRuntimeClient } from '@runnets/tools-node';

type WithClient = <T>(work: (client: LocalRuntimeClient) => Promise<T>) => Promise<T>;

const STATES = new Set([
  'started',
  'observed',
  'failed',
  'not_started',
  'uncertain',
  'acknowledged',
]);

export async function remotePluginOperationsCommand(
  action: string,
  rest: readonly string[],
  withClient: WithClient,
  roomId: string,
  usage: string,
): Promise<string | null> {
  if (action === 'operations') {
    const state = rest[0];
    if (state !== undefined && !STATES.has(state)) return usage;
    return withClient(async (client) => {
      const operations = await client.pluginOperationsList({
        roomId,
        ...(state === undefined ? {} : { state: state as never }),
      });
      return operations.length === 0
        ? 'No plugin operations in this room.'
        : operations
            .map(
              (operation) =>
                `${operation.id} ${operation.state} ${operation.tool} ` +
                `repo=${operation.repository} rev=${String(operation.revision)} ` +
                `bytes=${operation.resultBytes === null ? '-' : String(operation.resultBytes)}`,
            )
            .join('\n');
    });
  }
  if (action === 'operation') {
    const [operationId] = rest;
    if (!operationId) return usage;
    return withClient(async (client) => {
      const operation = await client.pluginOperationShow({ operationId });
      return [
        `operation ${operation.id} ${operation.state}`,
        `tool=${operation.tool} repo=${operation.repository} gen=${String(operation.connectionGeneration)}`,
        `endpoint=${operation.endpoint}`,
        `outcome=${operation.outcomeCode ?? '-'} detail=${operation.detail ?? '-'}`,
        `resultBytes=${operation.resultBytes === null ? '-' : String(operation.resultBytes)} truncated=${String(operation.truncated)}`,
        `created=${operation.createdAt} settled=${operation.settledAt ?? '-'}`,
      ].join('\n');
    });
  }
  if (action === 'acknowledge') {
    const [operationId, revision, ...reason] = rest;
    if (!operationId || revision === undefined) return usage;
    const expectedRevision = Number(revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return usage;
    return withClient(async (client) => {
      const operation = await client.pluginOperationAcknowledge({
        operationId,
        expectedRevision,
        ...(reason.length === 0 ? {} : { reason: reason.join(' ') }),
      });
      return (
        `Acknowledged ${operation.id} (revision ${String(operation.revision)}). ` +
        'The effect stays unknown and is not retried; only the journal hold was released.'
      );
    });
  }
  return null;
}
