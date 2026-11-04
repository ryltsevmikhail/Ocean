/**
 * `ocean plugin operations …` owner commands over the authenticated runtime.
 *
 * The runtime owns the durable journal; the CLI only renders bounded, secret-free
 * metadata. `acknowledge` is an explicit, versioned owner statement that keeps
 * the uncertain record and releases the journal hold — it never settles the
 * remote effect and never retries the call.
 */

import type { Writable } from 'node:stream';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { LocalPluginOperationView } from '@runnets/contracts';
import { required, type OceanArguments } from './arguments.js';

export interface PluginOperationsCommandResult {
  readonly data: unknown;
  readonly code: number;
}

const STATES = new Set([
  'started',
  'observed',
  'failed',
  'not_started',
  'uncertain',
  'acknowledged',
]);

function operationLine(operation: LocalPluginOperationView): string {
  return (
    `${operation.id} ${operation.state} ${operation.tool} repo=${operation.repository} ` +
    `gen=${String(operation.connectionGeneration)} ` +
    `bytes=${operation.resultBytes === null ? '-' : String(operation.resultBytes)}` +
    `${operation.truncated ? ' truncated' : ''} rev=${String(operation.revision)} ` +
    `created=${operation.createdAt}`
  );
}

function operationLines(operation: LocalPluginOperationView): readonly string[] {
  return [
    `operation ${operation.id}`,
    `state=${operation.state} tool=${operation.tool} repo=${operation.repository}`,
    `plugin=${operation.pluginId} connection=${operation.connectionId} gen=${String(operation.connectionGeneration)}`,
    `endpoint=${operation.endpoint}`,
    `schema=${operation.schemaDigest}`,
    `arguments=${operation.arguments}`,
    `argumentsDigest=${operation.argumentsDigest}`,
    `outcome=${operation.outcomeCode ?? '-'} detail=${operation.detail ?? '-'}`,
    `resultBytes=${operation.resultBytes === null ? '-' : String(operation.resultBytes)} truncated=${String(operation.truncated)}`,
    `created=${operation.createdAt} settled=${operation.settledAt ?? '-'}`,
    `acknowledged=${operation.acknowledgedAt ?? '-'} reason=${operation.acknowledgedReason ?? '-'}`,
  ];
}

function listQuery(args: OceanArguments) {
  const state = args.flags.get('state');
  if (state !== undefined && !STATES.has(state)) throw Error('invalid_input');
  const limit = args.flags.get('limit');
  const query: Record<string, string | number> = {};
  const room = args.flags.get('room');
  const bot = args.flags.get('bot');
  if (room !== undefined) query['roomId'] = room;
  if (bot !== undefined) query['botId'] = bot;
  if (state !== undefined) query['state'] = state;
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) throw Error('invalid_input');
    query['limit'] = parsed;
  }
  return query;
}

export async function runPluginOperationsCommand(
  client: LocalRuntimeClient,
  args: OceanArguments,
  output: Writable,
): Promise<PluginOperationsCommandResult> {
  const action = args.positional[1];
  const write = (values: readonly string[]) => {
    if (args.json) return;
    for (const value of values) output.write(value + '\n');
  };
  if (action === undefined || action === 'list') {
    const operations = await client.pluginOperationsList(listQuery(args));
    write(
      operations.length === 0 ? ['No plugin operations recorded.'] : operations.map(operationLine),
    );
    return { data: operations, code: 0 };
  }
  if (action === 'show') {
    const operation = await client.pluginOperationShow({
      operationId: required(args.flags, 'operation'),
    });
    write(operationLines(operation));
    return { data: operation, code: 0 };
  }
  if (action === 'acknowledge') {
    const operationId = required(args.flags, 'operation');
    const expectedRevision = Number(required(args.flags, 'revision'));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw Error('invalid_input');
    const reason = args.flags.get('reason');
    const operation = await client.pluginOperationAcknowledge({
      operationId,
      expectedRevision,
      ...(reason === undefined ? {} : { reason }),
    });
    write([
      ...operationLines(operation),
      'acknowledged: the effect stays unknown and is not retried; only the journal hold was released.',
    ]);
    return { data: operation, code: 0 };
  }
  throw Error('invalid_input');
}
