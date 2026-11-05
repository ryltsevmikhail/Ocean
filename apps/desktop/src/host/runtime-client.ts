import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { pageSize, type Command } from '../protocol.js';
import { dispatchModelSettings } from './model-settings-client.js';

// Only the native host selects the authenticated client and workspace.
export async function dispatch(client: LocalRuntimeClient, c: Command) {
  const workspaceId = 'ws_ocean';
  const page = {
    workspaceId,
    limit: pageSize,
    ...('after' in c && typeof c.after === 'string' ? { after: c.after } : {}),
  };
  switch (c.op) {
    case 'model-support':
    case 'model-presets':
    case 'model-connections':
    case 'model-set':
    case 'model-check':
    case 'model-disconnect':
    case 'model-remove-key':
    case 'bot-bound-create':
    case 'bot-binding-set':
    case 'bound-bots':
    case 'model-execution':
      return dispatchModelSettings(client, c);
    case 'receipt':
      return client.getReceipt({ workspaceId, roomId: c.room, requestId: c.requestId });
    case 'status':
      return client.status();
    case 'bot':
      return client.createBot({
        workspaceId,
        requestId: c.requestId,
        handle: c.handle,
        name: c.name,
        role: c.role,
        model: c.model,
        provider: 'deepseek',
      });
    case 'direct':
      return client.openDirect({ workspaceId, requestId: c.requestId, botId: c.bot });
    case 'group':
      return client.createGroup({
        workspaceId,
        requestId: c.requestId,
        title: c.title,
        botIds: c.bots,
      });
    case 'bots':
      return client.listBots(page);
    case 'rooms': {
      const result = [];
      for (const r of await client.listRooms(page)) {
        if (r.kind === 'direct') result.push(r);
        else {
          const members = await client.listMembers({ workspaceId, roomId: r.id, limit: 200 });
          result.push({ ...r, botIds: members.map((m) => m.id) });
        }
      }
      return result;
    }
    case 'runs':
      return client.listRuns({ ...page, roomId: c.room });
    case 'history':
      return client.history({ workspaceId, roomId: c.room, after: c.after, limit: pageSize });
    case 'observe': {
      const q = {
        workspaceId,
        roomId: c.room,
        ...(c.cursor === undefined ? {} : { cursor: c.cursor }),
        waitMs: 1000,
      };
      return c.runId ? client.observeRun({ ...q, runId: c.runId }) : client.observeRoom(q);
    }
    case 'cancel':
      return client.cancelRun({
        workspaceId,
        roomId: c.room,
        runId: c.runId,
        expectedVersion: c.expectedVersion,
        requestId: c.requestId,
      });
    case 'broadcast':
      return client.broadcastSubmit({
        workspaceId,
        roomId: c.room,
        requestId: c.requestId,
        text: c.text,
        ...(c.attachments === undefined ? {} : { attachments: c.attachments }),
      });
    case 'broadcast-list':
      return client.broadcastList({ workspaceId, roomId: c.room });
    case 'broadcast-continue':
      return client.broadcastContinue({
        workspaceId,
        roomId: c.room,
        batchId: c.batchId,
        expectedRevision: c.expectedRevision,
      });
    case 'broadcast-abandon':
      return client.broadcastAbandon({
        workspaceId,
        roomId: c.room,
        batchId: c.batchId,
        expectedRevision: c.expectedRevision,
      });
    case 'provider':
      return client.providerStatus();
    case 'provider-check':
      return client.providerCheck();
    case 'provider-set':
      return client.providerSet({
        requestId: c.requestId,
        model: c.model,
        ...(c.key === undefined ? {} : { key: c.key }),
      });
    case 'provider-disconnect':
      return client.providerDisconnect({
        requestId: c.requestId,
        expectedRevision: c.expectedRevision,
      });
    case 'provider-remove-key':
      return client.providerRemoveSavedKey({
        requestId: c.requestId,
        expectedRevision: c.expectedRevision,
      });
    case 'plugin-catalog':
      return client.pluginCatalog(c.search === undefined ? {} : { search: c.search });
    case 'plugin-inspect':
      return client.pluginInspect({ pluginId: c.pluginId });
    case 'plugin-install':
      return client.pluginInstall({
        pluginId: c.pluginId,
        ...(c.version === undefined ? {} : { version: c.version }),
      });
    case 'plugin-repair':
      return client.pluginRepair({
        pluginId: c.pluginId,
        ...(c.version === undefined ? {} : { version: c.version }),
      });
    case 'plugin-enable':
      return client.pluginEnable({
        pluginId: c.pluginId,
        ...(c.version === undefined ? {} : { version: c.version }),
      });
    case 'plugin-disable':
      return client.pluginDisable({ pluginId: c.pluginId });
    case 'plugin-connections':
      return client.pluginConnections();
    case 'plugin-connection-add':
      return client.pluginConnectionAdd({
        name: c.name,
        pluginId: c.pluginId,
        credentialReference: c.credentialReference,
        ...(c.accountLabel === undefined ? {} : { accountLabel: c.accountLabel }),
      });
    case 'plugin-connection-preview':
      return client.pluginConnectionPreview({ connectionId: c.connectionId });
    case 'plugin-connection-consent':
      return client.pluginConnectionConsent({
        connectionId: c.connectionId,
        expectedGeneration: c.expectedGeneration,
      });
    case 'plugin-connection-discover':
      return client.pluginConnectionDiscover({
        connectionId: c.connectionId,
        expectedGeneration: c.expectedGeneration,
      });
    case 'plugin-connection-disconnect':
      return client.pluginConnectionDisconnect({ connectionId: c.connectionId });
    case 'plugin-access-list':
      return client.pluginAccessList({
        ...(c.room === undefined ? {} : { roomId: c.room }),
        ...(c.bot === undefined ? {} : { botId: c.bot }),
      });
    case 'plugin-access-preview':
      return client.pluginAccessPreview({
        workspaceId,
        roomId: c.room,
        botId: c.botId,
        pluginId: 'github',
        connectionId: c.connectionId,
        tools: c.tools,
        repository: c.repository,
        acknowledgeGroupVisibility: c.acknowledgeGroupVisibility,
      });
    case 'plugin-access-grant':
      return client.pluginAccessGrant({
        workspaceId,
        roomId: c.room,
        botId: c.botId,
        pluginId: 'github',
        connectionId: c.connectionId,
        tools: c.tools,
        repository: c.repository,
        acknowledgeGroupVisibility: c.acknowledgeGroupVisibility,
      });
    case 'plugin-access-revoke':
      return client.pluginAccessRevoke({ grantId: c.grantId });
    case 'plugin-operations-list':
      return client.pluginOperationsList({
        ...(c.room === undefined ? {} : { roomId: c.room }),
        ...(c.state === undefined ? {} : { state: c.state }),
      });
    case 'plugin-operation-show':
      return client.pluginOperationShow({ operationId: c.operationId });
    case 'plugin-operation-acknowledge':
      return client.pluginOperationAcknowledge({
        operationId: c.operationId,
        expectedRevision: c.expectedRevision,
        ...(c.reason === undefined ? {} : { reason: c.reason }),
      });
    case 'send':
      return client.submit({
        workspaceId,
        roomId: c.room,
        requestId: c.requestId,
        text: c.text,
        ...(c.to === null ? {} : { to: c.to }),
      });
  }
}
