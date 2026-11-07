/**
 * Room TUI `/plugin …` owner commands.
 *
 * The TUI is a client of the same runtime services as the CLI and Desktop: it
 * reads catalog/connection/grant state and performs owner actions through the
 * authenticated runtime client. The group-visibility explanation is printed
 * before a grant; a second invocation ending in `ack` confirms it. No second
 * policy lives here.
 */

import type { LocalRuntimeClient } from '@runnets/tools-node';
import { remotePluginOperationsCommand } from './remote-plugin-operations.js';

interface PluginScope {
  readonly workspaceId: string;
  readonly roomId: string;
}

interface PluginConnection {
  withClient<T>(work: (client: LocalRuntimeClient) => Promise<T>): Promise<T>;
}

const USAGE = [
  'Use /plugin status, /plugin install, /plugin repair, /plugin enable, /plugin disable,',
  '/plugin connect NAME CREDENTIAL_ENV, /plugin connections,',
  '/plugin consent ID GEN, /plugin discover ID GEN, /plugin disconnect ID,',
  '/plugin grants, /plugin grant CONNECTION BOT REPOSITORY TOOL[,TOOL] (ack)',
  '/plugin revoke GRANT, /plugin operations [STATE], /plugin operation ID,',
  '/plugin acknowledge ID REVISION [reason].',
].join(' ');

function words(prompt: string): readonly string[] {
  return prompt.trim().split(/\s+/);
}

export class RemotePlugins {
  readonly #connection: PluginConnection;
  readonly #scope: PluginScope;
  constructor(connection: PluginConnection, scope: PluginScope) {
    this.#connection = connection;
    this.#scope = scope;
  }
  /** Returns a status line, or null when the draft is not a /plugin command. */
  async handle(prompt: string): Promise<string | null> {
    if (prompt !== '/plugin' && !prompt.startsWith('/plugin ')) return null;
    const [, action = 'status', ...rest] = words(prompt);
    try {
      return await this.#run(action, rest);
    } catch (error) {
      return 'plugin: ' + (error instanceof Error ? error.message : 'failed');
    }
  }
  async #run(action: string, rest: readonly string[]): Promise<string> {
    const withClient = <T>(work: (client: LocalRuntimeClient) => Promise<T>) =>
      this.#connection.withClient(work);
    const operations = await remotePluginOperationsCommand(
      action,
      rest,
      withClient,
      this.#scope.roomId,
      USAGE,
    );
    if (operations !== null) return operations;
    if (action === 'status' || action === '') {
      return withClient(async (client) => {
        const [catalog, connections, grants] = await Promise.all([
          client.pluginCatalog({}),
          client.pluginConnections(),
          client.pluginAccessList({ roomId: this.#scope.roomId }),
        ]);
        const lines = catalog.map(
          (entry) =>
            `${entry.pluginId}@${entry.version} ${entry.enabled ? 'enabled' : entry.installed ? 'disabled' : 'available'}`,
        );
        lines.push(
          ...connections.map(
            (connection) =>
              `connection ${connection.name} gen=${String(connection.generation)} ` +
              `${connection.state} readiness=${connection.readiness} identity=${connection.identityLabel} ` +
              `credential=${connection.credentialReference}`,
          ),
        );
        lines.push(
          ...grants
            .filter((grant) => grant.state === 'active')
            .map(
              (grant) =>
                `grant ${grant.id} bot=${grant.botId} repo=${grant.repository} ` +
                `tools=${grant.tools.join(',')}`,
            ),
        );
        return lines.length === 0 ? 'No plugins configured.' : lines.join('\n');
      });
    }
    if (action === 'repair') {
      return withClient(async (client) => {
        const repaired = await client.pluginRepair({ pluginId: 'github' });
        return `Repaired github@${repaired.version} (verified, disabled).`;
      });
    }
    if (action === 'install' || action === 'enable' || action === 'disable') {
      return withClient(async (client) => {
        if (action === 'install') {
          const installed = await client.pluginInstall({ pluginId: 'github' });
          return `Installed github@${installed.version} disabled.`;
        }
        if (action === 'enable') {
          const enabled = await client.pluginEnable({ pluginId: 'github' });
          return `Enabled github@${enabled.installed.version} (revoked grants ${String(enabled.revokedGrants)}).`;
        }
        const disabled = await client.pluginDisable({ pluginId: 'github' });
        return `Disabled github@${disabled.version}; grants revoked.`;
      });
    }
    if (action === 'connections') {
      return withClient(async (client) => {
        const connections = await client.pluginConnections();
        return connections.length === 0
          ? 'No connections.'
          : connections
              .map(
                (connection) =>
                  `${connection.id} "${connection.name}" gen=${String(connection.generation)} ` +
                  `${connection.state} readiness=${connection.readiness} endpoint=${connection.endpoint} ` +
                  `credential=${connection.credentialReference} ` +
                  `schema=${connection.schemaDigest === null ? 'none' : 'published'}`,
              )
              .join('\n');
      });
    }
    if (action === 'connect') {
      const [name, reference] = rest;
      if (!name || !reference) return USAGE;
      return withClient(async (client) => {
        const connection = await client.pluginConnectionAdd({
          name,
          pluginId: 'github',
          credentialReference: reference,
        });
        return (
          `Connection ${connection.id} "${connection.name}" generation ` +
          String(connection.generation) +
          '.'
        );
      });
    }
    if (action === 'consent') {
      const [connectionId, generation, ack] = rest;
      if (!connectionId || generation === undefined) return USAGE;
      return withClient(async (client) => {
        const prompt = await client.pluginConnectionPreview({ connectionId });
        if (ack !== 'ack')
          return (
            prompt.prompt +
            '\nSend /plugin consent ' +
            connectionId +
            ' ' +
            generation +
            ' ack to record this consent.'
          );
        const preview = await client.pluginConnectionConsent({
          connectionId,
          expectedGeneration: Number(generation),
        });
        return (
          prompt.prompt +
          '\nConsent recorded for ' +
          preview.endpoint +
          ' generation ' +
          String(preview.generation) +
          '. Send /plugin discover ' +
          connectionId +
          ' ' +
          String(preview.generation) +
          '.'
        );
      });
    }
    if (action === 'discover') {
      const [connectionId, generation] = rest;
      if (!connectionId || generation === undefined) return USAGE;
      return withClient(async (client) => {
        const result = await client.pluginConnectionDiscover({
          connectionId,
          expectedGeneration: Number(generation),
        });
        return (
          `Discovered ${String(result.connection.tools.length)} tools for ` +
          result.connection.name +
          '; schema ' +
          (result.connection.schemaDigest ?? 'none') +
          ', identity ' +
          result.connection.identityLabel +
          '.'
        );
      });
    }
    if (action === 'disconnect') {
      const [connectionId] = rest;
      if (!connectionId) return USAGE;
      return withClient(async (client) => {
        const result = await client.pluginConnectionDisconnect({ connectionId });
        return `Disconnected ${result.connection.name}; revoked grants ${String(result.revokedGrants)}.`;
      });
    }
    if (action === 'grants') {
      return withClient(async (client) => {
        const grants = await client.pluginAccessList({ roomId: this.#scope.roomId });
        return grants.length === 0
          ? 'No grants in this room.'
          : grants
              .map(
                (grant) =>
                  `${grant.id} ${grant.state} bot=${grant.botId} repo=${grant.repository} ` +
                  `tools=${grant.tools.join(',')}`,
              )
              .join('\n');
      });
    }
    if (action === 'grant') {
      const confirm = rest.includes('ack');
      const [connectionId, bot, repository, tools] = rest.filter((word) => word !== 'ack');
      if (!connectionId || !bot || !repository || !tools) return USAGE;
      const request = {
        workspaceId: this.#scope.workspaceId,
        roomId: this.#scope.roomId,
        botId: bot,
        pluginId: 'github',
        connectionId,
        tools: tools.split(',').filter(Boolean),
        repository,
        acknowledgeGroupVisibility: confirm,
      };
      return withClient(async (client) => {
        const preview = await client.pluginAccessPreview(request);
        if (!preview.allowed) return 'Grant refused: ' + (preview.refusal ?? 'unknown');
        if (!confirm) {
          return (
            preview.explanation +
            (preview.groupVisibility
              ? '\nSend the same command ending with ack to confirm the group visibility.'
              : '\nSend the same command ending with ack to confirm.')
          );
        }
        const grant = await client.pluginAccessGrant(request);
        // Re-print the freshly computed explanation with the confirmation so a
        // stale preview can never be the last thing the owner saw.
        const fresh = await client.pluginAccessPreview(request);
        return (
          fresh.explanation + '\nGranted ' + grant.id + ' for repository ' + grant.repository + '.'
        );
      });
    }
    if (action === 'revoke') {
      const [grantId] = rest;
      if (!grantId) return USAGE;
      return withClient(async (client) => {
        const grant = await client.pluginAccessRevoke({ grantId });
        return 'Grant ' + grant.id + ' ' + grant.state + '.';
      });
    }
    return USAGE;
  }
}
