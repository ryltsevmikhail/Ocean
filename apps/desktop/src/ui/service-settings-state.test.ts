import { expect, it, vi } from 'vitest';
import { createServiceSettings } from './service-settings-state.js';
const input = {
  requestId: 'old',
  connectionId: 'service',
  expectedVersions: null,
  name: 'Service',
  configuration: { kind: 'http' as const, url: 'http://localhost:8080' },
  metadataPermission: 'none' as const,
};
const prepared = {
  requestId: 'old',
  method: 'service.connection-set',
  state: 'prepared' as const,
  recovery: 'explicit_recovery_required' as const,
  targetId: 'service',
  operation: { method: 'service.connection-set' as const, input, requiresKey: true },
};
const receipt = {
  requestId: 'old',
  method: 'service.connection-set',
  state: 'prepared',
  recovery: 'explicit_recovery_required',
  result: null,
};
it('clears key before awaiting IPC; lost response looks up original receipt without resend', async () => {
  const sent: unknown[] = [];
  let reject!: (error: Error) => void;
  const request = vi.fn(async (c) => {
    sent.push(c);
    if (c.op === 'service-set')
      return new Promise((_, no) => {
        reject = no;
      });
    if (c.op === 'service-receipt') return { ...receipt, requestId: c.input.requestId };
    if (c.op === 'service-operations') return { items: [prepared], next: null };
    return [];
  });
  const s = createServiceSettings(request as never);
  await s.load();
  Object.assign(s.draft, input);
  s.key.value = 'synthetic-private-key';
  const work = s.save();
  expect(s.key.value).toBe('');
  expect(JSON.stringify(s.pending.value)).not.toContain('synthetic-private-key');
  reject(Error('outcome_unknown'));
  await work;
  expect(request.mock.calls.filter(([c]) => c.op === 'service-set')).toHaveLength(1);
  expect(request.mock.calls.find(([c]) => c.op === 'service-receipt')?.[0].input).toEqual({
    requestId: s.pending.value?.requestId,
  });
  expect(s.receipt.value?.state).toBe('prepared');
  expect(s.message.value).toContain('prepared');
});
it('discovers prepared intent on reopen; explicit recovery uses new ID/current versions and resupply', async () => {
  const request = vi.fn(async (c) =>
    c.op === 'service-operations'
      ? { items: [prepared], next: null }
      : c.op === 'service-set'
        ? { ...receipt, requestId: c.input.requestId }
        : [],
  );
  const s = createServiceSettings(request as never);
  await s.load();
  s.select('service');
  expect(s.operations.value).toEqual([prepared]);
  await s.recover(prepared);
  expect(request.mock.calls.filter(([c]) => c.op === 'service-set')).toHaveLength(0);
  s.selectRecovery(prepared);
  s.recoveryKey.value = 'synthetic-resupplied';
  await s.recover(prepared);
  const sent = request.mock.calls.find(([c]) => c.op === 'service-set')![0].input;
  expect(sent.requestId).not.toBe('old');
  expect(sent.expectedVersions).toBeNull();
  expect(sent.key).toBe('synthetic-resupplied');
  expect(s.key.value).toBe('');
});
it('late feedback cannot alter a changed room/bot/selection/window context', async () => {
  let resolve!: (v: unknown) => void;
  const request = vi.fn(async (c) =>
    c.op === 'service-set'
      ? new Promise((yes) => {
          resolve = yes;
        })
      : c.op === 'service-operations'
        ? { items: [], next: null }
        : [],
  );
  const s = createServiceSettings(request as never);
  await s.load();
  Object.assign(s.draft, input);
  const work = s.save();
  s.context('other-room', 'other-bot');
  s.close();
  resolve(receipt);
  await work;
  expect(s.receipt.value).toBeNull();
  expect(s.message.value).toBe('');
});
it('keeps grant version conflict visible and refreshes current facts without retry', async () => {
  const request = vi.fn(async (c) => {
    if (c.op === 'service-grant') throw Error('grant_revision_conflict');
    if (c.op === 'service-receipt') return null;
    return c.op === 'service-operations' ? { items: [], next: null } : [];
  });
  const s = createServiceSettings(request as never);
  await s.load();
  const { ownerGrant } = await import('../../../../test-fixtures/service-authority.js');
  const { id, permissions, mode, limits } = ownerGrant;
  await s.mutate({
    op: 'service-grant',
    input: {
      requestId: 'grant-request',
      expectedRevision: 2,
      intent: {
        id,
        permissions,
        mode,
        limits,
        subject: { ...ownerGrant.subject, workspaceId: 'ws_ocean' },
      },
    },
  });
  expect(s.message.value).toContain('grant_revision_conflict');
  expect(s.message.value).toContain('отсутствует');
  expect(request.mock.calls.filter(([c]) => c.op === 'service-grant')).toHaveLength(1);
});
it('refreshes selected declarative fields together with versions before a new owner save', async () => {
  const { serviceConnection } = await import('../../../../test-fixtures/service-authority.js');
  let current = { ...serviceConnection, tools: [], readiness: 'unknown' };
  const request = vi.fn(async (c) =>
    c.op === 'service-connections'
      ? [current]
      : c.op === 'service-operations'
        ? { items: [], next: null }
        : [],
  );
  const s = createServiceSettings(request as never);
  await s.load();
  s.select(current.id);
  current = {
    ...current,
    name: 'Changed in another owner',
    configRevision: 2,
    configuration: { kind: 'http', url: 'https://new.example/mcp' },
  };
  await s.load();
  expect(s.current.value?.configRevision).toBe(2);
  expect(s.draft.name).toBe('Changed in another owner');
  expect(s.draft.configuration).toEqual(current.configuration);
});
it('key removal uses persisted HTTP metadata and versions, ignoring dirty name URL permission and transport', async () => {
  const { serviceConnection } = await import('../../../../test-fixtures/service-authority.js');
  const c = { ...serviceConnection, state: 'disconnected', tools: [], readiness: 'disconnected' };
  const request = vi.fn(async (cmd) =>
    cmd.op === 'service-connections'
      ? [c]
      : cmd.op === 'service-operations'
        ? { items: [], next: null }
        : { ...receipt, requestId: cmd.input?.requestId },
  );
  const s = createServiceSettings(request as never);
  await s.load();
  s.select(c.id);
  Object.assign(s.draft, {
    name: 'Unsaved',
    metadataPermission: 'none',
    configuration: { kind: 'stdio', executable: '/dirty.js', sha256: 'a'.repeat(64), args: [] },
  });
  s.key.value = 'unrelated';
  await s.save(true);
  expect(request.mock.calls.find(([cmd]) => cmd.op === 'service-set')?.[0].input).toMatchObject({
    name: c.name,
    configuration: c.configuration,
    metadataPermission: c.trust.metadataPermission,
    removeKey: true,
    expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
  });
  expect(
    request.mock.calls.find(([cmd]) => cmd.op === 'service-set')?.[0].input,
  ).not.toHaveProperty('key');
});
it('refuses recovery A using a normal password entered for B when A has no current record', async () => {
  const request = vi.fn(async (c) =>
    c.op === 'service-operations'
      ? { items: [prepared], next: null }
      : c.op === 'service-set'
        ? { ...receipt, requestId: c.input.requestId }
        : [],
  );
  const s = createServiceSettings(request as never);
  await s.load();
  s.select('B');
  s.key.value = 'B-private';
  await s.recover(prepared);
  expect(request.mock.calls.filter(([c]) => c.op === 'service-set')).toHaveLength(0);
  expect(s.key.value).toBe('');
});
it('binds receipt feedback to the latest lookup even when completion order reverses', async () => {
  const finish = new Map<string, (v: unknown) => void>();
  const s = createServiceSettings(
    vi.fn(
      async (c) =>
        new Promise((resolve) => {
          finish.set(c.input.requestId, resolve);
        }),
    ) as never,
  );
  const a = s.lookup('A'),
    b = s.lookup('B');
  finish.get('B')!({ ...receipt, requestId: 'B' });
  await b;
  finish.get('A')!({ ...receipt, requestId: 'A' });
  await a;
  expect(s.receipt.value?.requestId).toBe('B');
});
it('clears the previous receipt immediately and on failure of a different lookup', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...receipt, requestId: 'A' })
    .mockRejectedValueOnce(Error('runtime_disconnected'));
  const s = createServiceSettings(request);
  await s.lookup('A');
  const b = s.lookup('B');
  expect(s.receipt.value).toBeNull();
  await b;
  expect(s.receipt.value).toBeNull();
  expect(s.message.value).toContain('runtime_disconnected');
});
it('fresh recovery selection clears both passwords and only its exact absent destination receives fresh resupply', async () => {
  const request = vi.fn(async (c) =>
    c.op === 'service-operations'
      ? { items: [prepared], next: null }
      : c.op === 'service-set'
        ? { ...receipt, requestId: c.input.requestId }
        : [],
  );
  const s = createServiceSettings(request as never);
  await s.load();
  s.select('B');
  s.key.value = 'B-key';
  s.selectRecovery(prepared);
  expect(s.key.value).toBe('');
  expect(s.recoveryKey.value).toBe('');
  await s.recover(prepared);
  expect(request.mock.calls.filter(([c]) => c.op === 'service-set')).toHaveLength(0);
  s.recoveryKey.value = 'A-fresh';
  const b = {
    ...prepared,
    requestId: 'B-op',
    targetId: 'B',
    operation: { ...prepared.operation, input: { ...input, requestId: 'B-op', connectionId: 'B' } },
  };
  await s.recover(b);
  expect(request.mock.calls.filter(([c]) => c.op === 'service-set')).toHaveLength(0);
  expect(s.recoveryKey.value).toBe('');
  s.selectRecovery(prepared);
  s.recoveryKey.value = 'A-fresh';
  const work = s.recover(prepared);
  expect(s.recoveryKey.value).toBe('');
  await work;
  const sent = request.mock.calls.find(([c]) => c.op === 'service-set')![0].input;
  expect(sent).toMatchObject({
    connectionId: 'service',
    key: 'A-fresh',
    expectedVersions: null,
    configuration: input.configuration,
  });
  expect(sent.requestId).not.toBe('old');
  s.selectRecovery(prepared);
  s.recoveryKey.value = 'cleared';
  s.context('other', 'bot');
  expect(s.recoveryKey.value).toBe('');
  expect(s.recoverySelection.value).toBeNull();
});
