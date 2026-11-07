import assert from 'node:assert/strict';
import { child } from './model-process-rpc.ts';
import { rig } from './model-process-rig.ts';
export async function oldHosts() {
  const results = [];
  for (const mode of ['safe', 'a3', 'unsafe']) {
    const f = await rig();
    const host = child('model-process-old-host.test.ts', [f.root + '/old', mode], f.env);
    let peer: ReturnType<typeof child> | undefined;
    try {
      await host.ready;
      peer = child('model-process-client.test.ts', [f.root + '/old', 'sdk'], f.env);
      if (mode === 'unsafe') await assert.rejects(peer.ready, /plugin_runtime_upgrade_required/);
      else {
        await peer.ready;
        await peer.call('status');
        if (mode === 'a3') assert.deepEqual(await peer.call('pluginCatalog'), []);
        for (const method of [
          'listModelConnections',
          'setModelConnection',
          'checkModelConnection',
          'disconnectModelConnection',
          'removeModelConnectionKey',
          'createBoundBot',
          'setBotModelBinding',
          'listBoundBots',
          'getRunModelExecution',
          'getRoomModelPolicy',
          'setRoomModelPolicy',
        ])
          await assert.rejects(peer.call(method), /^Error: model_runtime_upgrade_required$/);
      }
      const observed = await host.call<{ methods: string[]; features: string[] }>('inspect');
      assert.deepEqual(observed.features, [
        'plugin.session-authority-v1',
        'model.connections-v1',
        'decisions.service-v1',
        'service.authority-v2',
        'room.addressed-history-v1',
        'room.tasks-v1',
        'room.task-list-v1',
      ]);
      assert.deepEqual(
        observed.methods,
        mode === 'unsafe'
          ? ['hello']
          : mode === 'a3'
            ? ['hello', 'status', 'plugin.catalog']
            : ['hello', 'status'],
      );
      results.push({ mode, methods: observed.methods });
    } finally {
      await peer?.kill();
      await host.kill();
      await f.close();
    }
  }
  return results;
}
