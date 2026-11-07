import assert from 'node:assert/strict';
import { rig } from './model-process-rig.ts';
import { journal } from './model-process-execution.test.ts';
export async function categories() {
  const f = await rig();
  try {
    const owner = await f.launch(),
      peer = await f.peer();
    const baseline = await owner.snapshot();
    const result = [];
    for (const mode of ['mixed', 'unavailable', 'legacy', 'prefix']) {
      const query = { ...f.scope, runId: f.seed.runs[mode]! };
      const view = await peer.client.getRunModelExecution(query);
      if (mode === 'legacy') assert.equal(view.execution, null);
      else {
        assert.deepEqual(view.execution!.identity, {
          source: 'host',
          providerId: 'fixture',
          modelId: 'fixture',
        });
        const usage = view.execution!.usage;
        assert.deepEqual(usage.requestCounts, {
          actual: mode === 'mixed' || mode === 'prefix' ? 1 : 0,
          estimated: mode === 'mixed' ? 1 : 0,
          unavailable: mode === 'unavailable' ? 1 : 0,
          pending: 0,
        });
        assert.equal(usage.knownTokens, mode === 'prefix' ? 5 : 0);
        assert.equal(usage.estimatedTokens, 0);
        assert.equal(usage.completeness, mode === 'prefix' ? 'complete' : 'incomplete');
        assert.equal(usage.knownTokensScope, 'run_ledger_including_legacy_prefix');
        journal(f.profile, query.runId, view);
      }
      result.push({ mode, version: view.runVersion, usage: view.execution?.usage ?? null });
    }
    assert.deepEqual(await owner.snapshot(), baseline);
    return { provenance: 'synthetic-public-command-journals', result };
  } finally {
    await f.close();
  }
}
