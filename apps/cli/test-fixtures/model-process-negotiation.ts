import assert from 'node:assert/strict';
import { LOCAL_MODEL_METHODS, isLocalPluginInspectQuery } from '@runnets/contracts';
import { setInput, type rig } from './model-process-rig.ts';
import { settingsWitness } from './model-process-witness.ts';
type Rig = Awaited<ReturnType<typeof rig>>;
type Peer = Awaited<ReturnType<Rig['peer']>>;
export async function negotiationWaves(
  f: Rig,
  owner: Awaited<ReturnType<Rig['launch']>>,
  peers: Record<'sdk' | 'rc2' | 'a3' | 'modelOnly' | 'unknown', Peer>,
  revision: number,
  phase: string,
) {
  const { sdk, rc2, a3, modelOnly, unknown } = peers;
  const statuses = async () => {
    for (const [peer, size, plugins, models] of [
      [rc2, 45, false, false],
      [a3, 65, true, false],
      [sdk, 79, true, true],
      [modelOnly, 46, false, true],
      [unknown, 45, false, false],
    ] as const) {
      const status = await peer.client.status();
      assert.equal(status.capabilities.length, size);
      assert.equal(status.capabilities.includes('plugin.session-authority-v1'), plugins);
      assert.equal(status.capabilities.includes('model.connections-v1'), models);
      assert.equal(status.capabilities.includes('decisions.service-v1'), peer === sdk);
      assert.equal(status.capabilities.includes('service.authority-v2'), peer === sdk);
      assert.equal(status.capabilities.includes('room.addressed-history-v1'), peer === sdk);
    }
  };
  const denied = async (run: () => Promise<unknown>) => {
    const baseline = await owner.snapshot(),
      canonical = settingsWitness(f.profile);
    await run();
    await statuses();
    assert.deepEqual(await owner.snapshot(), baseline);
    assert.equal(
      settingsWitness(f.profile) === canonical,
      true,
      'denied operation mutated canonical authority',
    );
  };
  const pluginInput = { pluginId: 'github' };
  assert.equal(isLocalPluginInspectQuery(pluginInput), true);
  const steps: Record<string, () => Promise<void>> = {
    modelMutation: async () => {
      const result = await sdk.client.setModelConnection({
        ...setInput,
        requestId: phase + '-set-' + revision,
        expectedRevision: revision === 0 ? null : revision,
      });
      assert.equal(result.revision, ++revision);
      await statuses();
    },
    legacyModel: () =>
      denied(async () => {
        for (const peer of [rc2, a3, unknown]) {
          await assert.rejects(
            peer.raw('modelConnections.set', setInput),
            /model_runtime_upgrade_required/,
          );
          await statuses();
          for (const method of LOCAL_MODEL_METHODS) {
            await assert.rejects(peer.raw(method), /model_runtime_upgrade_required/);
            await statuses();
          }
        }
      }),
    legacyPluginMutation: () =>
      denied(async () => {
        for (const peer of [rc2, modelOnly, unknown]) {
          await assert.rejects(peer.raw('plugin.catalog'), /plugin_runtime_upgrade_required/);
          await statuses();
          await assert.rejects(
            peer.raw('plugin.disable', pluginInput),
            /plugin_runtime_upgrade_required/,
          );
          await statuses();
        }
      }),
    pluginReads: async () => {
      assert.ok(Array.isArray(await a3.raw('plugin.catalog')));
      await statuses();
      assert.ok(Array.isArray(await sdk.client.pluginCatalog()));
      await statuses();
    },
    modelReads: async () => {
      assert.equal((await sdk.client.listModelConnections()).version, 1);
      await statuses();
      assert.equal((await modelOnly.raw<{ version: number }>('modelConnections.list')).version, 1);
      await statuses();
    },
  };
  const forward = Object.keys(steps),
    reverse = [...forward].reverse();
  for (const order of [forward, reverse]) for (const step of order) await steps[step]!();
  await assert.rejects(rc2.raw('future.fixture'), /method_not_found/);
  await statuses();
  return { revision, orders: [forward, reverse] };
}
