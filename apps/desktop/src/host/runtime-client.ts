import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { pageSize, type Command } from '../protocol.js';

// Only the native host selects the authenticated client and workspace.
export async function dispatch(client: LocalRuntimeClient, c: Command) {
  const workspaceId = 'ws_ocean';
  const page = {
    workspaceId,
    limit: pageSize,
    ...('after' in c && typeof c.after === 'string' ? { after: c.after } : {}),
  };
  switch (c.op) {
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
