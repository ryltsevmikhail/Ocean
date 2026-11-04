import { expect, it } from 'vitest';
import { sessionRig } from '../test-fixtures/github-session-rig.js';
import { turnFor } from '../test-fixtures/real-adapter-rig.js';

it('transmits the exact read-only GitHub catalog headers to the real HTTP adapter', async () => {
  const r = await sessionRig();
  await r.discover();
  expect(r.observations.length).toBeGreaterThan(0);
  expect(
    r.observations.every(
      (entry) => entry.tools === 'list_issues,issue_read' && entry.readonly === 'true',
    ),
  ).toBe(true);
  expect(r.business()).toHaveLength(0);
});

it('clears published authority on generation change and dispatches only the newly discovered account', async () => {
  const r = await sessionRig();
  await r.discover();
  r.grant();
  expect((await r.execute()).output).toContain('fixture-account-A');
  const previous = r.connection();
  r.runtime.services.connections.change({
    connectionId: previous.id,
    expectedGeneration: previous.generation,
    credentialReference: 'OCEAN_ACCOUNT_B',
  });
  expect(r.connection()).toMatchObject({
    schemaDigest: null,
    tools: [],
    identity: null,
    lastDiscoveryAt: null,
  });
  expect(() => r.grant()).toThrow();
  const before = r.observations.length;
  await r.discover();
  r.grant();
  expect((await r.execute()).output).toContain('fixture-account-B');
  expect(r.observations.slice(before).every((entry) => entry.account === 'B')).toBe(true);
  expect(r.business().map((entry) => entry.account)).toEqual(['A', 'B']);
});

it('refuses a changed raw credential behind the same reference until new consent and grant', async () => {
  const r = await sessionRig();
  await r.discover();
  r.grant();
  r.env['OCEAN_ACCOUNT_A'] = 'synthetic-account-B';
  const before = r.observations.length;
  expect(await r.runtime.tools?.forTurn(turnFor(), new AbortController().signal)).toBeNull();
  expect(() => r.grant()).toThrow();
  expect(r.connection()).toMatchObject({ readiness: 'discovery_required', schemaDigest: null });
  expect(r.observations).toHaveLength(before);
  await r.discover();
  r.grant();
  expect((await r.execute()).output).toContain('fixture-account-B');
  expect(r.business().map((entry) => entry.account)).toEqual(['B']);
});

it('restarts without network and durably requires fresh discovery and owner grant', async () => {
  const r = await sessionRig();
  await r.discover();
  r.grant();
  const before = r.observations.length;
  await r.restart();
  expect(r.observations).toHaveLength(before);
  expect(r.connection()).toMatchObject({ readiness: 'discovery_required', tools: [] });
  expect(r.store.pluginAccess.grants().every((entry) => entry.state === 'revoked')).toBe(true);
  expect(await r.runtime.tools?.forTurn(turnFor(), new AbortController().signal)).toBeNull();
  expect(() => r.grant()).toThrow();
  r.runtime.services.catalog.enable({ pluginId: 'github' });
  await r.discover();
  r.grant();
  expect((await r.execute()).isError).toBe(false);
  expect(r.business()).toHaveLength(1);
});

it.each(['extra', 'missing', 'duplicate', 'refuseReadonly'] as const)(
  'refuses an invalid or refused upstream catalog (%s) without business traffic',
  async (mode) => {
    const r = await sessionRig();
    r.controls[mode] = true;
    await expect(r.discover()).rejects.toThrow();
    expect(r.connection().schemaDigest).toBeNull();
    expect(() => r.grant()).toThrow();
    expect(r.business()).toHaveLength(0);
  },
);

it('revokes a stale schema grant and binds the discovery receipt to its final durable generation', async () => {
  const r = await sessionRig();
  await r.discover();
  const grant = r.grant();
  r.controls.schemaRevision++;
  const discovered = await r.discover();
  expect(discovered.authorityChanged).toBe(true);
  expect(discovered.connection.generation).toBe(grant.connectionGeneration + 1);
  expect(discovered.connection).toMatchObject({ readiness: 'ready' });
  expect(await r.runtime.tools?.forTurn(turnFor(), new AbortController().signal)).toBeNull();
  expect(r.business()).toHaveLength(0);
  r.grant();
  expect((await r.execute()).isError).toBe(false);
  expect(r.business()).toHaveLength(1);
});

it.each(['generation', 'credential'] as const)(
  'never activates a candidate discovery after concurrent %s change',
  async (mode) => {
    const r = await sessionRig();
    let release: () => void = () => {};
    r.controls.listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const discovering = r.discover();
    const refusal = expect(discovering).rejects.toThrow();
    while (!r.observations.some((entry) => entry.method === 'tools/list'))
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (mode === 'credential') r.env['OCEAN_ACCOUNT_A'] = 'synthetic-account-B';
    else {
      const current = r.connection();
      r.runtime.services.connections.change({
        connectionId: current.id,
        expectedGeneration: current.generation,
        credentialReference: 'OCEAN_ACCOUNT_B',
      });
    }
    release();
    await refusal;
    expect(r.connection()).toMatchObject({ readiness: 'discovery_required', tools: [] });
    expect(() => r.grant()).toThrow();
    expect(r.business()).toHaveLength(0);
    await r.discover();
    r.grant();
    expect((await r.execute()).output).toContain('fixture-account-B');
    expect(r.business().map((entry) => entry.account)).toEqual(['B']);
  },
);

it('preserves exact same-session grants across successful rediscovery', async () => {
  const r = await sessionRig();
  await r.discover();
  const grant = r.grant();
  const discovered = await r.discover();
  expect(discovered.authorityChanged).toBe(false);
  expect(discovered.connection.generation).toBe(grant.connectionGeneration);
  expect((await r.execute()).isError).toBe(false);
  expect(r.business()).toHaveLength(1);
});

it('uses only the current account when changed before the first discovery', async () => {
  const r = await sessionRig();
  const current = r.connection();
  r.runtime.services.connections.change({
    connectionId: current.id,
    expectedGeneration: current.generation,
    credentialReference: 'OCEAN_ACCOUNT_B',
  });
  await r.discover();
  r.grant();
  expect((await r.execute()).isError).toBe(false);
  expect(r.observations.every((entry) => entry.account === 'B')).toBe(true);
});

it('keeps an already dispatched call on its immutable account while the connection changes', async () => {
  const r = await sessionRig();
  await r.discover();
  r.grant();
  let release: () => void = () => {};
  r.controls.callGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calling = r.execute();
  while (r.business().length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const current = r.connection();
  r.runtime.services.connections.change({
    connectionId: current.id,
    expectedGeneration: current.generation,
    credentialReference: 'OCEAN_ACCOUNT_B',
  });
  await r.discover();
  r.grant();
  release();
  expect((await calling).output).toContain('fixture-account-A');
  expect((await r.execute()).output).toContain('fixture-account-B');
  expect(r.business().map((entry) => entry.account)).toEqual(['A', 'B']);
  expect(r.runtime.operations?.list().every((entry) => entry.state === 'observed')).toBe(true);
});

it('refuses bot, room, repository, tool and stale-grant scopes before any business request', async () => {
  const r = await sessionRig();
  await r.discover();
  const grant = r.grant(['list_issues']);
  const request = {
    workspaceId: grant.workspaceId,
    roomId: grant.roomId,
    botId: grant.botId,
    pluginId: grant.pluginId,
    connectionId: grant.connectionId,
    grantId: grant.id,
    tool: 'list_issues',
    arguments: { owner: 'team', repo: 'api' },
    claim: { invocationId: 'denied', taskRunId: 'run_1', attemptId: 'attempt_1' },
  };
  for (const patch of [
    { botId: 'wrong-bot' },
    { roomId: 'wrong-room' },
    { arguments: { owner: 'wrong', repo: 'repo' } },
    { tool: 'issue_read' },
  ]) {
    const result = await r.runtime.admission?.call({ ...request, ...patch });
    expect(result).toMatchObject({ admitted: false });
  }
  const current = r.connection();
  r.runtime.services.connections.change({
    connectionId: current.id,
    expectedGeneration: current.generation,
    credentialReference: 'OCEAN_ACCOUNT_B',
  });
  await r.discover();
  expect(await r.runtime.admission?.call(request)).toMatchObject({ admitted: false });
  expect(r.business()).toHaveLength(0);
  expect(r.runtime.operations?.list()).toHaveLength(0);
});
