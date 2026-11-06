import { expect, it } from 'vitest';
import {
  canonicalJson,
  validServiceOwnerOperation,
  validServiceOwnerOperationsQuery,
  validServiceConnectionSetRequest,
  validServiceGrantSetRequest,
  validServiceToolDefinition,
  validOwnerScopeGrant,
  validServiceConnection,
} from '@runnets/domain';
import {
  isLocalServiceOwnerOperationsPage,
  isLocalServiceGrants,
  isLocalServiceOwnerOperationItem,
  isLocalServiceOwnerReceipt,
  normalizeLocalServiceConnections,
} from './local-service-views.js';
import {
  serviceConnection,
  serviceCatalog,
  ownerGrant,
} from '../../../test-fixtures/service-authority.js';
const input = {
  requestId: 'request',
  connectionId: 'new',
  expectedVersions: null,
  name: 'New',
  configuration: { kind: 'http', url: 'https://example.com/mcp' },
  metadataPermission: 'none',
};
it('accepts only exact keyless intent and bounded query fields, including original versions', () => {
  const op = { method: 'service.connection-set', input, requiresKey: true };
  expect(validServiceOwnerOperation(op)).toBe(true);
  for (const extra of [
    { key: 'secret' },
    { secretReference: 'saved:private' },
    { ownerId: 'foreign' },
  ])
    expect(validServiceOwnerOperation({ ...op, input: { ...input, ...extra } })).toBe(false);
  expect(validServiceOwnerOperation({ ...op, input: { ...input, removeKey: true } })).toBe(false);
  expect(validServiceOwnerOperation({ ...op, requiresKey: 'yes' })).toBe(false);
  for (const query of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { state: 'unknown' },
    { after: '' },
    { ownerId: 'foreign' },
    { retry: true },
  ])
    expect(validServiceOwnerOperationsQuery(query)).toBe(false);
  for (const query of [
    {},
    { after: 'opaque', limit: 100, state: 'completed' },
    { limit: 1, state: 'prepared' },
  ])
    expect(validServiceOwnerOperationsQuery(query)).toBe(true);
});
it('keeps legacy prepared data unknown and rejects result/state or method mismatches', () => {
  expect(
    isLocalServiceOwnerOperationsPage({
      items: [
        {
          requestId: 'old',
          method: 'service.connection-set',
          state: 'prepared',
          recovery: 'explicit_recovery_required',
          targetId: null,
          operation: null,
        },
      ],
      next: null,
    }),
  ).toBe(true);
  const prepared = {
    requestId: 'old',
    method: 'service.connection-set',
    state: 'prepared',
    recovery: 'explicit_recovery_required',
    result: null,
  };
  expect(isLocalServiceOwnerReceipt(prepared)).toBe(true);
  expect(isLocalServiceOwnerReceipt({ ...prepared, result: serviceConnection })).toBe(false);
  expect(isLocalServiceOwnerReceipt({ ...prepared, state: 'completed', recovery: null })).toBe(
    false,
  );
  expect(
    isLocalServiceOwnerReceipt({
      ...prepared,
      method: 'service.grant-set',
      state: 'completed',
      recovery: null,
      result: serviceConnection,
    }),
  ).toBe(false);
});
it('rejects sparse public arrays and never infers readiness from durable active state', () => {
  expect(
    normalizeLocalServiceConnections([{ ...serviceConnection, tools: [] }])?.[0]?.readiness,
  ).toBe('unknown');
  expect(normalizeLocalServiceConnections(new Array(1))).toBeNull();
});

import {
  legacyServiceOwnerMetadata,
  serviceOwnerFieldCases,
} from '../../../test-fixtures/service-owner-views.js';

it.each(serviceOwnerFieldCases)(
  'uses originating record rules for tool/grant target %j (valid=%s)',
  (name, valid) => {
    const tool = { ...serviceCatalog.tools[0]!, name },
      grant = { ...ownerGrant, id: name };
    const { subject, permissions, limits, mode } = grant;
    expect(validServiceToolDefinition(tool)).toBe(valid);
    expect(validOwnerScopeGrant(grant)).toBe(valid);
    expect(
      validServiceGrantSetRequest({
        requestId: 'history',
        expectedRevision: null,
        intent: { id: name, subject, permissions, limits, mode },
      }),
    ).toBe(valid);
    expect(
      normalizeLocalServiceConnections([{ ...serviceConnection, tools: [name] }]) !== null,
    ).toBe(valid);
    expect(
      isLocalServiceOwnerOperationItem({
        requestId: 'history',
        method: 'service.grant-set',
        state: 'completed',
        recovery: null,
        targetId: name,
        operation: null,
      }),
    ).toBe(valid);
  },
);
it('keeps captured connection IDs and opaque request IDs under their existing request guard', () => {
  const captured = { ...input, connectionId: 'é'.repeat(128), requestId: 'é'.repeat(128) };
  expect(validServiceConnectionSetRequest(captured)).toBe(true);
  expect(validServiceConnection({ ...serviceConnection, id: captured.connectionId })).toBe(false);
  const item = {
    requestId: captured.requestId,
    method: 'service.connection-set',
    state: 'prepared',
    recovery: 'explicit_recovery_required',
    targetId: captured.connectionId,
    operation: { method: 'service.connection-set', input: captured, requiresKey: false },
  };
  expect(isLocalServiceOwnerOperationItem(item)).toBe(true);
  expect(isLocalServiceOwnerOperationsPage({ items: [item], next: captured.requestId })).toBe(true);
  expect(
    isLocalServiceOwnerOperationsPage({
      items: [{ ...item, requestId: 'bad\trequest' }],
      next: null,
    }),
  ).toBe(false);
  expect(validServiceOwnerOperationsQuery({ after: 'bad\tcursor' })).toBe(false);
});
it('rejects invented or absent historical targets and contradictory disconnect/readiness facts', () => {
  const item = {
    requestId: 'old',
    method: 'service.connection-refresh',
    state: 'prepared',
    recovery: 'explicit_recovery_required',
    targetId: null,
    operation: null,
  };
  expect(isLocalServiceOwnerOperationItem(item)).toBe(true);
  expect.soft(isLocalServiceOwnerOperationItem({ ...item, targetId: 'invented' })).toBe(false);
  expect
    .soft(isLocalServiceOwnerOperationItem({ ...item, state: 'completed', recovery: null }))
    .toBe(false);
  expect(
    isLocalServiceOwnerOperationItem({
      ...item,
      state: 'completed',
      recovery: null,
      targetId: 'third',
    }),
  ).toBe(true);
  const disconnected = { ...serviceConnection, state: 'disconnected' as const },
    receipt = {
      requestId: 'off',
      method: 'service.connection-disconnect',
      state: 'completed',
      recovery: null,
    };
  expect.soft(isLocalServiceOwnerReceipt({ ...receipt, result: serviceConnection })).toBe(false);
  expect(isLocalServiceOwnerReceipt({ ...receipt, result: disconnected })).toBe(true);
  expect
    .soft(normalizeLocalServiceConnections([{ ...disconnected, tools: [], readiness: 'ready' }]))
    .toBeNull();
  expect
    .soft(
      normalizeLocalServiceConnections([
        { ...serviceConnection, tools: [], readiness: 'disconnected' },
      ]),
    )
    .toBeNull();
  const legacy = normalizeLocalServiceConnections([{ ...disconnected, tools: [] }]);
  expect(legacy?.[0]?.readiness).toBe('unknown');
  expect(normalizeLocalServiceConnections(legacy)).toEqual(legacy);
});
it('accepts exact legacy400000 item budgets for connections and grants, refusing overage and entry overflow', () => {
  const { connections, grants } = legacyServiceOwnerMetadata();
  expect(connections.every(({ tools: _tools, ...r }) => validServiceConnection(r))).toBe(true);
  expect(grants.every(validOwnerScopeGrant)).toBe(true);
  for (const rows of [connections, grants]) {
    expect(rows.reduce((sum, r) => sum + canonicalJson(r).length, 0)).toBe(400000);
    expect(canonicalJson(rows).length).toBe(400101);
  }
  expect.soft(normalizeLocalServiceConnections(connections)).toHaveLength(100);
  expect.soft(isLocalServiceGrants(grants)).toBe(true);
  expect(
    normalizeLocalServiceConnections([
      { ...connections[0]!, name: connections[0]!.name + 'x' },
      ...connections.slice(1),
    ]),
  ).toBeNull();
  expect(
    isLocalServiceGrants([
      { ...grants[0]!, subject: { ...grants[0]!.subject, botId: 'botx' } },
      ...grants.slice(1),
    ]),
  ).toBe(false);
  expect(
    normalizeLocalServiceConnections(
      Array.from({ length: 101 }, (_, n) => ({ ...serviceConnection, id: String(n), tools: [] })),
    ),
  ).toBeNull();
  expect(
    isLocalServiceGrants(Array.from({ length: 101 }, (_, n) => ({ ...ownerGrant, id: String(n) }))),
  ).toBe(false);
});

it('keeps history page envelopes strictly within400000 while metadata retains legacy accounting', () => {
  const items = Array.from({ length: 100 }, (_, n) => {
    const requestId = String(n),
      captured = {
        ...input,
        requestId,
        configuration: { kind: 'http', url: 'https://example.com/' + 'x'.repeat(4000) },
      };
    return {
      requestId,
      method: 'service.connection-set',
      state: 'prepared',
      recovery: 'explicit_recovery_required',
      targetId: input.connectionId,
      operation: { method: 'service.connection-set', input: captured, requiresKey: false },
    };
  });
  expect(items.every((i) => validServiceOwnerOperation(i.operation))).toBe(true);
  const page = { items, next: null };
  expect(canonicalJson(page).length).toBeGreaterThan(400000);
  expect(isLocalServiceOwnerOperationsPage(page)).toBe(false);
});
