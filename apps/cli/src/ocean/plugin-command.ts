/**
 * `ocean plugin …` owner commands.
 *
 * The CLI is only a client of the shared runtime services: catalog, named
 * connection references and exact grants are composed and rechecked inside the
 * runtime. Credential values never appear in arguments; `--credential-env`
 * carries an environment variable NAME only.
 */

import type { Readable, Writable } from 'node:stream';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { OceanArguments } from './arguments.js';
import { required } from './arguments.js';
import { runPluginOperationsCommand } from './plugin-operations-command.js';

export interface PluginCommandResult {
  readonly data: unknown;
  readonly code: number;
}
type Output = Writable;

function lines(output: Output, values: readonly string[]): void {
  for (const value of values) output.write(value + '\n');
}
function pluginId(args: OceanArguments): string {
  return required(args.flags, 'plugin');
}
function connectionId(args: OceanArguments): string {
  return (
    args.flags.get('connection') ??
    args.flags.get('connection-id') ??
    required(args.flags, 'connection')
  );
}
function requestedVersion(args: OceanArguments): { pluginId: string; version?: string } {
  const version = args.flags.get('version');
  return {
    pluginId: pluginId(args),
    ...(version === undefined ? {} : { version }),
  };
}
function generation(args: OceanArguments): number {
  const value = Number(required(args.flags, 'generation'));
  if (!Number.isSafeInteger(value) || value < 1) throw Error('invalid_input');
  return value;
}
function grantRequest(args: OceanArguments) {
  const connection = connectionId(args);
  const bot = required(args.flags, 'bot');
  const repository = args.flags.get('repository') ?? args.flags.get('repo');
  if (repository === undefined) throw Error('Missing --repository');
  const tools = args.tools;
  if (tools.length === 0) throw Error('Missing --tool');
  return {
    workspaceId: 'ws_ocean',
    roomId: required(args.flags, 'room'),
    botId: bot,
    pluginId: pluginId(args),
    connectionId: connection,
    tools,
    repository,
    acknowledgeGroupVisibility: args.groupVisibilityAcknowledged,
  };
}

export async function runPluginCommand(
  client: LocalRuntimeClient,
  args: OceanArguments,
  output: Output,
  input: Readable,
  error: Output,
): Promise<PluginCommandResult> {
  void input;
  const [area, action] = args.positional;
  if (area === 'operations') return runPluginOperationsCommand(client, args, output);
  if (area === 'catalog') {
    if (action === undefined || action === 'list') {
      const search = args.flags.get('search');
      const entries = await client.pluginCatalog(search === undefined ? {} : { search });
      if (!args.json)
        lines(
          output,
          entries.map(
            (entry) =>
              `${entry.pluginId} ${entry.version} ${entry.publisher} ` +
              `${entry.enabled ? 'enabled' : entry.installed ? 'installed/disabled' : 'not installed'} ` +
              `tools=${entry.tools.join(',')} endpoint=${entry.endpoint}`,
          ),
        );
      return { data: entries, code: 0 };
    }
    if (action === 'inspect') {
      const entry = await client.pluginInspect({ pluginId: pluginId(args) });
      if (!args.json)
        lines(output, [
          `${entry.pluginId} ${entry.version} (${entry.publisher})`,
          `transport=${entry.transport} endpoint=${entry.endpoint} readOnly=${String(entry.readOnly)}`,
          `tools=${entry.tools.join(',')} digest=${entry.manifestDigest}`,
          `installed=${String(entry.installed)} enabled=${String(entry.enabled)} verified=${String(entry.fileVerified)}`,
        ]);
      return { data: entry, code: 0 };
    }
    if (action === 'repair') {
      const repaired = await client.pluginRepair(requestedVersion(args));
      if (!args.json)
        lines(output, [
          `${repaired.pluginId} ${repaired.version} repaired ` +
            `(verified=${String(repaired.verified)}, disabled)`,
        ]);
      return { data: repaired, code: 0 };
    }
    if (action === 'install' || action === 'enable' || action === 'disable') {
      if (action === 'disable') {
        const installed = await client.pluginDisable({ pluginId: pluginId(args) });
        if (!args.json) lines(output, [`${installed.pluginId} ${installed.version} disabled`]);
        return { data: installed, code: 0 };
      }
      const request = requestedVersion(args);
      if (action === 'install') {
        const installed = await client.pluginInstall(request);
        if (!args.json)
          lines(output, [
            `${installed.pluginId} ${installed.version} installed disabled ` +
              `sha256=${installed.manifestDigest}`,
          ]);
        return { data: installed, code: 0 };
      }
      const result = await client.pluginEnable(request);
      if (!args.json)
        lines(output, [
          `${result.installed.pluginId} ${result.installed.version} enabled ` +
            `(revoked grants: ${String(result.revokedGrants)})`,
        ]);
      return { data: result, code: 0 };
    }
    throw Error('invalid_input');
  }
  if (area === 'connections') {
    if (action === undefined || action === 'list') {
      const connections = await client.pluginConnections();
      if (!args.json)
        lines(
          output,
          connections.map(
            (connection) =>
              `${connection.id} ${connection.name} ${connection.pluginId}@${connection.pluginVersion} ` +
              `gen=${String(connection.generation)} ${connection.state} ` +
              `identity=${connection.identityLabel} credential=${connection.credentialReference} ` +
              `schema=${connection.schemaDigest ?? 'none'}`,
          ),
        );
      return { data: connections, code: 0 };
    }
    if (action === 'add') {
      const account = args.flags.get('account');
      const connection = await client.pluginConnectionAdd({
        name: args.flags.get('name') ?? 'work',
        pluginId: pluginId(args),
        credentialReference:
          args.flags.get('credential-env') ?? args.flags.get('credential-ref') ?? '',
        ...(account === undefined ? {} : { accountLabel: account }),
      });
      if (!args.json)
        lines(output, [
          `connection ${connection.id} "${connection.name}" generation ${String(connection.generation)} ` +
            `endpoint ${connection.endpoint}`,
        ]);
      return { data: connection, code: 0 };
    }
    if (action === 'preview') {
      const preview = await client.pluginConnectionPreview({ connectionId: connectionId(args) });
      if (!args.json) lines(output, [preview.prompt, `consented=${String(preview.consented)}`]);
      return { data: preview, code: 0 };
    }
    if (action === 'consent') {
      const id = connectionId(args);
      // The owner must see the exact endpoint before consent is recorded.
      const preview = await client.pluginConnectionPreview({ connectionId: id });
      if (!preview.consented && !args.json) lines(output, [preview.prompt]);
      if (!args.endpointAcknowledged) {
        error.write(
          'consent not recorded: read the endpoint prompt above and repeat with ' +
            '--acknowledge-endpoint\n',
        );
        return { data: preview, code: 4 };
      }
      const recorded = await client.pluginConnectionConsent({
        connectionId: id,
        expectedGeneration: generation(args),
      });
      if (!args.json)
        lines(output, [`consent recorded for generation ${String(recorded.generation)}`]);
      return { data: recorded, code: 0 };
    }
    if (action === 'discover') {
      const result = await client.pluginConnectionDiscover({
        connectionId: connectionId(args),
        expectedGeneration: generation(args),
      });
      if (!args.json)
        lines(output, [
          `discovered ${String(result.connection.tools.length)} tools ` +
            `schema=${result.connection.schemaDigest ?? 'none'} ` +
            `identity=${result.connection.identityLabel}`,
        ]);
      return { data: result, code: 0 };
    }
    if (action === 'disconnect') {
      const result = await client.pluginConnectionDisconnect({ connectionId: connectionId(args) });
      if (!args.json)
        lines(output, [
          `connection ${result.connection.id} ${result.connection.state} ` +
            `generation ${String(result.connection.generation)} ` +
            `revoked grants ${String(result.revokedGrants)}`,
        ]);
      return { data: result, code: 0 };
    }
    throw Error('invalid_input');
  }
  if (area === 'access') {
    if (action === undefined || action === 'list') {
      const filter: { roomId?: string; botId?: string } = {};
      const room = args.flags.get('room');
      if (room !== undefined) filter.roomId = room;
      const bot = args.flags.get('bot');
      if (bot !== undefined) filter.botId = bot;
      const grants = await client.pluginAccessList(filter);
      if (!args.json)
        lines(
          output,
          grants.map(
            (grant) =>
              `${grant.id} ${grant.state} room=${grant.roomId} bot=${grant.botId} ` +
              `repo=${grant.repository} tools=${grant.tools.join(',')} ` +
              `gen=${String(grant.connectionGeneration)}`,
          ),
        );
      return { data: grants, code: 0 };
    }
    if (action === 'grant') {
      const request = grantRequest(args);
      const preview = await client.pluginAccessPreview(request);
      if (!preview.allowed) {
        error.write(`grant refused: ${preview.refusal ?? 'unknown'}\n`);
        return { data: preview, code: 4 };
      }
      // The owner sees exactly who can read the answer before confirming.
      if (!args.json) lines(output, [preview.explanation]);
      if (!request.acknowledgeGroupVisibility && preview.groupVisibility) {
        error.write(
          'grant not confirmed: pass --acknowledge-group-visibility after reading the explanation\n',
        );
        return { data: preview, code: 4 };
      }
      const grant = await client.pluginAccessGrant(request);
      if (!args.json)
        lines(output, [`granted ${grant.id} state=${grant.state} schema=${grant.schemaDigest}`]);
      return { data: grant, code: 0 };
    }
    if (action === 'revoke') {
      const grant = await client.pluginAccessRevoke({ grantId: required(args.flags, 'grant') });
      if (!args.json) lines(output, [`grant ${grant.id} ${grant.state}`]);
      return { data: grant, code: 0 };
    }
    throw Error('invalid_input');
  }
  throw Error('invalid_input');
}
