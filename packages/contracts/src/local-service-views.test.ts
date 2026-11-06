import { expect, it } from 'vitest';
import { validServiceOwnerOperation, validServiceOwnerOperationsQuery } from '@runnets/domain';
import {
  isLocalServiceOwnerOperationsPage,
  isLocalServiceOwnerReceipt,
  normalizeLocalServiceConnections,
} from './local-service-views.js';
import { serviceConnection } from '../../../test-fixtures/service-authority.js';
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
