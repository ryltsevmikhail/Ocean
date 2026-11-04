import { expect, it } from 'vitest';
import * as wire from './index.js';
const set = {
  connectionId: 'é'.repeat(128),
  requestId: 'request',
  expectedRevision: null,
  providerId: 'openai',
  kind: 'cloud',
  endpoint: 'https://api.openai.com/v1',
  auth: 'api_key',
  defaultModelId: 'm'.repeat(256),
};
it('accepts actual 256-byte IDs and closes the new request boundary', () => {
  expect(wire.isLocalModelConnectionSetRequest(set)).toBe(true);
  for (const extra of [
    { key: null },
    { secretRef: 'private' },
    { expectedRevision: [] },
    { connectionId: 'é'.repeat(129) },
    { defaultModelId: 'm'.repeat(257) },
  ])
    expect(wire.isLocalModelConnectionSetRequest({ ...set, ...extra })).toBe(false);
  expect(wire.isLocalModelConnectionsQuery({ byteBudget: 1 })).toBe(false);
  expect(wire.LOCAL_MODEL_METHODS).toHaveLength(11);
});
it('accepts closed keyless recovery, including legacy omission, without credential fields', () => {
  const request = {
    version: 1,
    operation: {
      method: 'provider.set',
      input: { requestId: 'r', model: 'deepseek-chat' },
      keyWasSupplied: true,
    },
  };
  expect(wire.isLocalModelPendingRequest(request)).toBe(true);
  for (const extra of [{ key: 'never' }, { expectedRevision: null }])
    expect(
      wire.isLocalModelPendingRequest({
        ...request,
        operation: { ...request.operation, input: { ...request.operation.input, ...extra } },
      }),
    ).toBe(false);
});

it('closes metadata fields and recovery identity/version without leaking private authority', async () => {
  const { metadata } = await import('../test-fixtures/local-model.js');
  const m = metadata();
  expect(wire.isLocalModelConnectionMetadata(m)).toBe(true);
  for (const extra of [
    { secretRef: 'private' },
    { binding: 'digest' },
    { localQualification: [] },
    { configuration: { ...m.configuration, intent: ['active'] } },
    { models: Array(201).fill({}) },
  ])
    expect(wire.isLocalModelConnectionMetadata({ ...m, ...extra })).toBe(false);
  const pending = {
    ...m,
    configuration: { ...m.configuration, intent: 'pending' },
    recovery: {
      kind: 'retry_available',
      pendingRevision: 1,
      requiresKeyResupply: true,
      request: {
        version: 1,
        operation: {
          method: 'modelConnections.set',
          input: {
            ...set,
            connectionId: 'named',
            expectedRevision: null,
            defaultModelId: m.defaultModelId,
            providerId: m.providerId,
            endpoint: m.endpoint,
          },
          keyWasSupplied: true,
        },
      },
    },
  };
  expect(wire.isLocalModelConnectionMetadata(pending)).toBe(true);
  expect(wire.isLocalModelConnectionMetadata({ ...pending, connectionId: 'foreign' })).toBe(false);
  expect(wire.isLocalModelConnectionMetadata({ ...pending, revision: 2 })).toBe(false);
  expect(wire.isLocalModelPendingRequest({ ...pending.recovery.request, version: 2 })).toBe(false);
});
it('preserves actual-zero, estimated-zero, unavailable and unknown counts as distinct typed evidence', async () => {
  const { execution } = await import('../test-fixtures/local-model.js');
  const r = execution();
  const e = r.execution!;
  expect(wire.isLocalRunModelExecution(r)).toBe(true);
  for (const [usage, counts, completeness] of [
    [
      {
        kind: 'estimated',
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        estimator: 'test',
      },
      { actual: 0, estimated: 1, unavailable: 0, pending: 0 },
      'incomplete',
    ],
    [
      { kind: 'unavailable', reason: 'not_reported' },
      { actual: 0, estimated: 0, unavailable: 1, pending: 0 },
      'incomplete',
    ],
    [e.lastRequest.settlement!.usage, null, 'unknown'],
  ] as const) {
    expect(
      wire.isLocalRunModelExecution({
        ...r,
        execution: {
          ...e,
          lastRequest: { ...e.lastRequest, settlement: { ...e.lastRequest.settlement, usage } },
          usage: { ...e.usage, requestCounts: counts, completeness },
        },
      }),
    ).toBe(true);
  }
  expect(
    wire.isLocalRunModelExecution({
      ...r,
      execution: { ...e, identity: { ...e.identity, endpoint: 'private' } },
    }),
  ).toBe(false);
  expect(
    wire.isLocalRunModelExecution({
      ...r,
      execution: { ...e, usage: { ...e.usage, requestCounts: null } },
    }),
  ).toBe(false);
});
