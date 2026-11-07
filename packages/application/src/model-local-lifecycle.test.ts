import { expect, it } from 'vitest';
import { ModelConnectionService } from './model-connections.js';
import { modelFixture, localSet } from '../test-fixtures/model-connections.js';
import type { LocalModelQualification } from './model-local-qualification.js';
import type { LocalModelCheckResult } from './model-credential-ports.js';
const q: LocalModelQualification = {
  modelId: 'fixture-model',
  artifactDigest: 'a'.repeat(64),
  backendVersion: 'fixture-1',
  configuredContextTokens: 4096,
  capabilities: {
    tools: true,
    streaming: true,
    inputModalities: ['text'],
    contextTokens: 4096,
    maxOutputTokens: null,
    usage: 'optional',
  },
};
function setup() {
  const f = modelFixture(ModelConnectionService);
  let evidence = q;
  let probe: ((signal: AbortSignal) => Promise<LocalModelCheckResult>) | null = null;
  let checks = 0;
  const activate = f.factory.activate;
  f.factory.catalog = (d) =>
    d.localQualification
      ? [{ modelId: d.localQualification.modelId, capabilities: d.localQualification.capabilities }]
      : [];
  f.factory.activate = (d, s) => (d.localQualification ? activate(d, s) : null);
  Object.assign(f.factory, {
    localBootstrap: {
      acceptsDesired: (d: { providerId: string }) => d.providerId === 'fixture',
      prepareCheck: () => ({
        source: 'auth_none',
        check: async (signal: AbortSignal) => {
          checks++;
          return probe
            ? probe(signal)
            : { outcome: 'ok', httpStatus: 200, qualification: evidence };
        },
      }),
    },
  });
  return {
    ...f,
    setEvidence: (v: LocalModelQualification) => {
      evidence = v;
    },
    setProbe: (v: typeof probe) => {
      probe = v;
    },
    checks: () => checks,
  };
}
it('saves desired local intent without a catalog or executable provider, then CAS publishes evidence and identity', async () => {
  const f = setup(),
    input = localSet('local');
  const initial = f.service.set(input);
  expect(initial).toMatchObject({
    state: 'unverified',
    revision: 1,
    models: [],
    code: 'provider_unverified',
  });
  expect(f.rows.get('local')?.localQualification).toBeNull();
  expect(f.service.current('local')).toBeNull();
  const result = await f.service.check('local');
  expect(result).toMatchObject({
    status: { state: 'connected', revision: 2 },
    check: {
      outcome: 'ok',
      persisted: true,
      revision: 1,
      models: ['fixture-model'],
      modelSupported: true,
    },
  });
  expect(f.rows.get('local')?.localQualification).toEqual(q);
  expect(f.service.current('local')).not.toBeNull();
  expect(f.secretCalls).toEqual([]);
  expect(f.externalCalls).toEqual([]);
  expect(f.service.set(input)).toEqual(initial);
  expect(f.checks()).toBe(1);
});
it('keeps identical evidence at R, publishes changed evidence at R+1 and retains it after failed recheck', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  await f.service.check('local');
  expect((await f.service.check('local')).status.revision).toBe(2);
  f.setEvidence({ ...q, backendVersion: 'fixture-2' });
  expect((await f.service.check('local')).status.revision).toBe(3);
  f.setProbe(async () => ({ outcome: 'network', httpStatus: null }));
  expect(await f.service.check('local')).toMatchObject({
    status: { revision: 3, state: 'connected', lastCheck: { outcome: 'network', revision: 3 } },
    check: { persisted: true, models: [], modelSupported: false },
  });
  expect(f.rows.get('local')?.localQualification?.backendVersion).toBe('fixture-2');
});
it.each(['set', 'disconnect', 'remove', 'competing'] as const)(
  'does not rebase a delayed check after %s wins',
  async (action) => {
    const f = setup();
    f.service.set(localSet('local'));
    await f.service.check('local');
    let finish!: (v: LocalModelCheckResult) => void;
    f.setProbe(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const checking = f.service.check('local');
    if (action === 'set')
      f.service.set({ ...localSet('local'), requestId: 'new', expectedRevision: 2 });
    if (action === 'disconnect')
      f.service.disconnect({ connectionId: 'local', requestId: 'dis', expectedRevision: 2 });
    if (action === 'remove')
      f.service.removeSavedKey({ connectionId: 'local', requestId: 'rem', expectedRevision: 2 });
    if (action === 'competing') {
      f.setProbe(null);
      f.setEvidence({ ...q, backendVersion: 'winner' });
      await f.service.check('local');
    }
    const before = structuredClone(f.rows.get('local'));
    finish({ outcome: 'ok', httpStatus: 200, qualification: { ...q, backendVersion: 'stale' } });
    expect((await checking).check.persisted).toBe(false);
    expect(f.rows.get('local')).toEqual(before);
  },
);
it('refuses a late successful check after cancellation and after commit failure', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  const abort = new AbortController();
  f.setProbe(async () => {
    abort.abort();
    return { outcome: 'ok', httpStatus: 200, qualification: q };
  });
  expect((await f.service.check('local', abort.signal)).check).toMatchObject({
    outcome: 'cancelled',
    persisted: false,
  });
  expect(f.rows.get('local')?.localQualification).toBeNull();
  f.setProbe(null);
  f.store.put = () => {
    throw Error('commit failed');
  };
  expect((await f.service.check('local')).check.persisted).toBe(false);
  expect(f.rows.get('local')?.revision).toBe(1);
});
it('fresh set and key removal invalidate evidence, replay does not', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  await f.service.check('local');
  f.service.removeSavedKey({ connectionId: 'local', requestId: 'remove', expectedRevision: 2 });
  expect(f.rows.get('local')?.localQualification).toBeNull();
  await f.service.check('local');
  expect(f.rows.get('local')?.revision).toBe(4);
  const input = { ...localSet('local'), requestId: 'fresh', expectedRevision: 4 };
  f.service.set(input);
  expect(f.rows.get('local')?.localQualification).toBeNull();
  await f.service.check('local');
  f.service.set(input);
  expect(f.rows.get('local')?.revision).toBe(6);
});
it.each([
  { disabled: true },
  { injected: { id: 'x' } },
  { mutationsAllowed: false },
  { restored: true },
])('does not qualify through closed gates %j', async (gates) => {
  const f = setup();
  f.service.set(localSet('local'));
  Object.assign(f.options, gates);
  if ('restored' in gates)
    f.rows.set('local', { ...f.rows.get('local')!, configuredAfterRestore: false });
  expect((await f.service.check('local')).check.persisted).toBe(false);
  expect(f.checks()).toBe(0);
});
it('refuses malformed none+secretRef before secret reads and refuses disconnected checking', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  f.rows.set('local', { ...f.rows.get('local')!, secretRef: 'bad' });
  expect(f.service.status('local').state).toBe('unverified');
  expect((await f.service.check('local')).check.persisted).toBe(false);
  expect(f.secretCalls).toEqual([]);
  f.rows.set('local', { ...f.rows.get('local')!, secretRef: null, intent: 'disconnected' });
  await f.service.check('local');
  expect(f.checks()).toBe(0);
});
it('refuses overflow and invalid successful evidence without publishing', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  f.rows.set('local', { ...f.rows.get('local')!, revision: Number.MAX_SAFE_INTEGER });
  expect((await f.service.check('local')).check.persisted).toBe(false);
  expect(f.rows.get('local')?.localQualification).toBeNull();
  f.rows.set('local', { ...f.rows.get('local')!, revision: 1 });
  f.setEvidence({ ...q, modelId: 'different' });
  expect((await f.service.check('local')).check.outcome).not.toBe('ok');
  expect(f.rows.get('local')?.localQualification).toBeNull();
});
it('does not let the later completion of two changed checks overwrite the first winner', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  let first!: (v: LocalModelCheckResult) => void, second!: (v: LocalModelCheckResult) => void;
  f.setProbe(
    () =>
      new Promise((resolve) => {
        first = resolve;
      }),
  );
  const a = f.service.check('local');
  f.setProbe(
    () =>
      new Promise((resolve) => {
        second = resolve;
      }),
  );
  const b = f.service.check('local');
  second({ outcome: 'ok', httpStatus: 200, qualification: { ...q, backendVersion: 'second' } });
  expect((await b).check.persisted).toBe(true);
  first({ outcome: 'ok', httpStatus: 200, qualification: { ...q, backendVersion: 'first' } });
  expect((await a).check.persisted).toBe(false);
  expect(f.rows.get('local')?.localQualification?.backendVersion).toBe('second');
});
it('enforces cancellation when the metadata capability ignores its signal', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  f.setProbe(() => new Promise(() => {}));
  const abort = new AbortController();
  const pending = f.service.check('local', abort.signal);
  abort.abort();
  expect((await pending).check).toMatchObject({ outcome: 'cancelled', persisted: false });
  expect(f.rows.get('local')?.localQualification).toBeNull();
});
it('records a failed saved-key recheck without erasing previous evidence', async () => {
  const f = setup();
  f.service.set(localSet('local'));
  await f.service.check('local');
  f.rows.set('local', { ...f.rows.get('local')!, auth: 'api_key', secretRef: 'missing' });
  const result = await f.service.check('local');
  expect(result.check).toMatchObject({ outcome: 'unavailable', persisted: true });
  expect(f.rows.get('local')).toMatchObject({
    revision: 2,
    localQualification: q,
    lastCheck: { outcome: 'unavailable' },
  });
});
