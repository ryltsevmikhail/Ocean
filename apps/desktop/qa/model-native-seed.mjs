import assert from 'node:assert/strict';

export const workspaceId = 'ws_ocean';
export const cloud = {
  kind: 'cloud',
  providerId: 'deepseek',
  endpoint: 'https://api.deepseek.com',
  auth: 'api_key',
  defaultModelId: 'deepseek-flash',
};
export const local = {
  kind: 'local',
  providerId: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  auth: 'none',
  defaultModelId: 'qwen3:1.7b',
};
export async function seedModelSettings(
  peer,
  { connectionCount = 51, botCount = 51, step = (issue) => issue() } = {},
) {
  assert.ok(Number.isSafeInteger(connectionCount) && connectionCount > 0 && connectionCount <= 100);
  assert.ok(Number.isSafeInteger(botCount) && botCount > 0 && botCount <= 100);
  const connections = [],
    bots = [];
  for (let i = 0; i < connectionCount; i++) {
    const connectionId = 'qa-' + String(i).padStart(3, '0'),
      descriptor = i === 0 ? local : cloud;
    await step(() =>
      peer.setModelConnection({
        ...descriptor,
        connectionId,
        expectedRevision: null,
        requestId: 'save-' + connectionId,
        ...(descriptor.auth === 'api_key' ? { key: 'synthetic-native-fixture' } : {}),
      }),
    );
    const { check } = await step(() => peer.checkModelConnection({ connectionId }));
    assert.equal(check.outcome, 'ok', connectionId + ': ' + JSON.stringify(check));
    connections.push({ connectionId, modelId: descriptor.defaultModelId });
  }
  for (let i = 0; i < botCount; i++) {
    const handle = 'bot' + String(i).padStart(3, '0');
    bots.push(
      await step(() =>
        peer.createBoundBot({
          workspaceId,
          requestId: 'create-' + handle,
          handle,
          name: handle,
          role: 'Synthetic settings fixture',
          binding: connections[i % connections.length],
        }),
      ),
    );
  }
  return { connections, bots };
}
export async function readPages(peer, step = (issue) => issue()) {
  const bots = await step(() => peer.listBoundBots({ workspaceId })),
    connections = await step(() => peer.listModelConnections());
  assert.equal(bots.items.length, 50);
  assert.equal(connections.items.length, 50);
  assert.ok(bots.nextAfter && connections.nextAfter);
  const lastBots = await step(() => peer.listBoundBots({ workspaceId, after: bots.nextAfter }));
  const lastConnections = await step(() =>
    peer.listModelConnections({ after: connections.nextAfter }),
  );
  assert.equal(lastBots.nextAfter, null);
  assert.equal(lastConnections.nextAfter, null);
  return {
    bots: [...bots.items, ...lastBots.items],
    connections: [...connections.items, ...lastConnections.items],
    lastBots: lastBots.items,
    lastConnections: lastConnections.items,
  };
}
