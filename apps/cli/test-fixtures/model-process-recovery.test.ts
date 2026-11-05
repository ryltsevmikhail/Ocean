import assert from 'node:assert/strict';
import { rig, setInput, effects } from './model-process-rig.ts';
import { activeWitness, pendingWitness } from './model-process-witness.ts';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { isLocalProviderStatus as frozenProvider } from './rc2-provider-contract.ts';
type Mutation =
  'setModelConnection' | 'removeModelConnectionKey' | 'providerSet' | 'providerRemoveSavedKey';
const cases = [
  ['new', 'before'],
  ['new', 'after'],
  ['rotation', 'before'],
  ['remove', 'after'],
  ['legacy-set', 'before'],
  ['legacy-remove', 'after'],
  ['keyless', 'before'],
] as const;
export async function recovery() {
  const totals: unknown[] = [];
  for (const [family, timing] of cases) {
    const f = await rig();
    try {
      const first = await f.launch();
      const requester = await f.peer();
      const legacy = family.startsWith('legacy');
      const remove = family.endsWith('remove');
      const removesViaSet = family === 'keyless';
      const descriptor = removesViaSet
        ? {
            ...setInput,
            providerId: 'ollama',
            kind: 'local' as const,
            endpoint: 'http://127.0.0.1:11434',
            defaultModelId: 'qwen3:1.7b',
          }
        : setInput;
      const connectionId = legacy ? 'legacy:deepseek' : 'named';
      if (family !== 'new' && family !== 'legacy-set') {
        if (legacy)
          await requester.client.providerSet({
            requestId: 'setup',
            key: setInput.key,
            model: 'deepseek-flash',
          });
        else await requester.client.setModelConnection({ ...descriptor, requestId: 'setup' });
      }
      const { key: _setupKey, ...localKeyless } = descriptor;
      const original = removesViaSet
        ? { ...localKeyless, requestId: 'pending', expectedRevision: 1, auth: 'none' as const }
        : legacy
          ? remove
            ? { requestId: 'pending', expectedRevision: 1 }
            : { requestId: 'pending', key: setInput.key, model: 'deepseek-flash' }
          : remove
            ? { connectionId, requestId: 'pending', expectedRevision: 1 }
            : { ...setInput, requestId: 'pending', expectedRevision: family === 'new' ? null : 1 };
      const method: Mutation = legacy
        ? remove
          ? 'providerRemoveSavedKey'
          : 'providerSet'
        : remove
          ? 'removeModelConnectionKey'
          : 'setModelConnection';
      const wire = legacy
        ? remove
          ? 'provider.removeSavedKey'
          : 'provider.set'
        : remove
          ? 'modelConnections.removeSavedKey'
          : 'modelConnections.set';
      const invoke = (client: LocalRuntimeClient, input: unknown = original) =>
        (client[method] as (v: unknown) => Promise<unknown>)(input).then((result) => {
          if (legacy) assert.equal(frozenProvider(result), true, 'frozen provider receipt refused');
          return result;
        });
      const baseline = await first.snapshot();
      const { key: _key, ...keyless } = original as Record<string, unknown>;
      const envelope = {
        version: 1,
        operation: {
          method: wire,
          input: keyless,
          ...(!remove ? { keyWasSupplied: !removesViaSet } : {}),
        },
      };
      await first.call('fault', {
        requestId: 'pending',
        timing,
        expected: {
          envelope,
          revision: family === 'new' || family === 'legacy-set' ? 1 : 2,
          action: remove || removesViaSet ? 'remove' : 'replace',
        },
      });
      await assert.rejects(invoke(requester.client), /^Error: provider_write_failed$/);
      const pending = pendingWitness(f.profile, 'pending');
      const pendingRevision = pending.row!['revision'];
      const failed = await first.snapshot();
      assert.equal(failed.counters.attempt - baseline.counters.attempt, 1);
      assert.equal(
        failed.counters.published - baseline.counters.published,
        timing === 'before' ? 0 : 1,
      );
      assert.ok(failed.phases.includes('pending-committed-before-publication'));
      if (timing === 'after') assert.ok(failed.phases.includes('published-before-activation'));
      await first.kill();
      await requester.kill();
      const successor = await f.launch();
      assert.notEqual(successor.info.identity.instanceId, first.info.identity.instanceId);
      assert.notEqual(successor.info.pid, first.info.pid);
      assert.equal((await successor.snapshot()).counters.attempt, 0);
      assert.equal(
        JSON.stringify(pendingWitness(f.profile, 'pending')) === JSON.stringify(pending),
        true,
        'pending witness changed',
      );
      const a = await f.peer(),
        b = await f.peer();
      const recovery = (await a.client.listModelConnections()).items.find(
        (r) => r.connectionId === connectionId,
      )!.recovery;
      assert.ok(recovery?.kind === 'retry_available');
      assert.equal(recovery.pendingRevision, pendingRevision);
      assert.equal(recovery.requiresKeyResupply, !remove && !removesViaSet);
      assert.deepEqual(recovery.request, envelope);
      assert.doesNotMatch(
        JSON.stringify(recovery),
        /synthetic-fixture-key|secretRef|previousRef|nextRef|digest/,
      );
      const beforeRefusals = await successor.snapshot();
      const actionChange = legacy
        ? a.client.providerDisconnect({ requestId: 'pending', expectedRevision: 1 })
        : a.client.disconnectModelConnection({
            connectionId,
            requestId: 'pending',
            expectedRevision: 1,
          });
      await assert.rejects(actionChange, /request_conflict/);
      const changed: [unknown, string][] = [
        [{ ...original, requestId: 'replacement' }, 'provider_unverified'],
        [
          { ...original, expectedRevision: 77 },
          legacy && !remove ? 'invalid_params' : 'request_conflict',
        ],
      ];
      if (!remove && !removesViaSet) {
        changed.push([{ ...original, key: 'synthetic-wrong-key' }, 'request_conflict']);
        changed.push([keyless, 'request_conflict']);
        changed.push([
          { ...original, [legacy ? 'model' : 'defaultModelId']: 'deepseek-v4-pro' },
          'request_conflict',
        ]);
      }
      if (!legacy) {
        changed.push([{ ...original, connectionId: 'foreign' }, 'request_conflict']);
        if (!remove)
          changed.push([
            {
              ...original,
              endpoint: removesViaSet
                ? 'http://127.0.0.1:11435'
                : 'https://api.deepseek.com/changed',
            },
            'request_conflict',
          ]);
      }
      for (const [input, code] of changed)
        await assert.rejects(invoke(a.client, input), new RegExp('^Error: ' + code + '$'));
      if (legacy)
        await assert.rejects(
          a.client.setModelConnection({
            ...setInput,
            connectionId,
            requestId: 'pending',
            expectedRevision: 0,
          }),
          /request_conflict/,
        );
      else
        await assert.rejects(
          a.client.providerSet({
            requestId: 'pending',
            model: 'deepseek-flash',
            key: setInput.key,
          }),
          /request_conflict/,
        );
      if (!remove && !legacy)
        await assert.rejects(
          a.client.removeModelConnectionKey({
            connectionId,
            requestId: 'pending',
            expectedRevision: 1,
          }),
          /request_conflict/,
        );
      assert.deepEqual(effects(await successor.snapshot()), effects(beforeRefusals));
      assert.equal(
        JSON.stringify(pendingWitness(f.profile, 'pending')) === JSON.stringify(pending),
        true,
        'pending witness changed',
      );
      const [receipt, second] = await Promise.all([invoke(a.client), invoke(b.client)]);
      assert.deepEqual(second, receipt);
      const active = activeWitness(f.profile, 'pending');
      assert.equal(active.row!['revision'], pendingRevision);
      const wave = await successor.snapshot();
      assert.equal(wave.counters.attempt, 1);
      assert.equal(wave.counters.published, 1);
      assert.equal(wave.counters.probe, 0);
      assert.equal(wave.counters.dispatch, 0);
      assert.deepEqual(await invoke(a.client), receipt);
      assert.deepEqual(await invoke(b.client), receipt);
      assert.equal(
        JSON.stringify(activeWitness(f.profile, 'pending')) === JSON.stringify(active),
        true,
        'active witness changed',
      );
      assert.deepEqual(effects(await successor.snapshot()), effects(wave));
      totals.push({
        family,
        timing,
        attempts: 2,
        published: timing === 'before' ? 1 : 2,
        revision: pendingRevision,
        ownerPids: [first.info.pid, successor.info.pid],
        recoveryOwners: [a.info.pid, b.info.pid],
      });
    } finally {
      await f.close();
    }
  }
  return { cases: totals };
}
