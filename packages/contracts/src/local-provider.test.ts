import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROVIDER_METHODS,
  isLocalProviderCheckResponse,
  isLocalProviderQuery,
  isLocalProviderRevisionRequest,
  isLocalProviderSetRequest,
  isLocalProviderStatus,
  type LocalProviderCheckResponse,
  type LocalProviderStatus,
} from './index.js';

const status: LocalProviderStatus = {
  provider: 'deepseek',
  source: 'saved',
  state: 'connected',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  modelCapabilities: [
    { model: 'deepseek-flash', imageInput: true },
    { model: 'deepseek-v4-pro', imageInput: false },
  ],
  revision: 2,
  savedKey: true,
  writable: true,
  code: null,
  lastCheck: {
    outcome: 'ok',
    httpStatus: 200,
    durationMs: 42,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelSupported: true,
    source: 'saved',
    revision: 2,
    checkedAt: '2026-11-04T00:00:00.000Z',
  },
};
const check: LocalProviderCheckResponse = {
  status,
  check: { ...status.lastCheck!, persisted: true },
};

describe('local provider contract', () => {
  it('exposes the owner-visible methods as capabilities', () => {
    expect(LOCAL_PROVIDER_METHODS).toEqual([
      'provider.status',
      'provider.check',
      'provider.set',
      'provider.disconnect',
      'provider.removeSavedKey',
    ]);
  });

  it('validates a metadata-only status DTO', () => {
    expect(isLocalProviderStatus(status)).toBe(true);
    expect(isLocalProviderStatus({ ...status, modelCapabilities: [] })).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-');
  });

  it('rejects a status carrying a credential or an unknown enum value', () => {
    expect(isLocalProviderStatus({ ...status, key: 'sk-leak' })).toBe(false);
    expect(isLocalProviderStatus({ ...status, source: 'key' })).toBe(false);
    expect(isLocalProviderStatus({ ...status, state: 'enabled' })).toBe(false);
    expect(isLocalProviderStatus({ ...status, model: 7 })).toBe(false);
    expect(isLocalProviderStatus({ ...status, revision: -1 })).toBe(false);
    expect(isLocalProviderStatus({ ...status, code: 'Not Stable' })).toBe(false);
    expect(
      isLocalProviderStatus({ ...status, modelCapabilities: [{ model: 'x', imageInput: 'yes' }] }),
    ).toBe(false);
    expect(isLocalProviderStatus({ ...status, models: ['x'.repeat(257)] })).toBe(false);
    expect(
      isLocalProviderStatus({
        ...status,
        lastCheck: { ...status.lastCheck, checkedAt: 'not-a-date' },
      }),
    ).toBe(false);
  });

  it('accepts an empty query only', () => {
    expect(isLocalProviderQuery({})).toBe(true);
    expect(isLocalProviderQuery({ requestId: 'x' })).toBe(false);
    expect(isLocalProviderQuery([])).toBe(false);
  });

  it('validates set requests and bounds the transient key', () => {
    expect(isLocalProviderSetRequest({ requestId: 'r1', model: 'deepseek-flash' })).toBe(true);
    expect(
      isLocalProviderSetRequest({ requestId: 'r1', model: 'deepseek-flash', key: 'sk-key' }),
    ).toBe(true);
    expect(isLocalProviderSetRequest({ requestId: 'r1', model: 'deepseek-flash', key: '' })).toBe(
      false,
    );
    expect(
      isLocalProviderSetRequest({ requestId: 'r1', model: 'deepseek-flash', key: '   ' }),
    ).toBe(false);
    expect(
      isLocalProviderSetRequest({ requestId: 'r1', model: 'deepseek-flash', key: 'x'.repeat(513) }),
    ).toBe(false);
    expect(isLocalProviderSetRequest({ requestId: 'r1', model: '' })).toBe(false);
    expect(isLocalProviderSetRequest({ requestId: '', model: 'deepseek-flash' })).toBe(false);
    expect(
      isLocalProviderSetRequest({ requestId: 'r1', model: 'deepseek-flash', extra: true }),
    ).toBe(false);
    expect(isLocalProviderSetRequest({ requestId: 'r1' })).toBe(false);
  });

  it('validates revision requests with a non-negative revision', () => {
    expect(isLocalProviderRevisionRequest({ requestId: 'r1', expectedRevision: 0 })).toBe(true);
    expect(isLocalProviderRevisionRequest({ requestId: 'r1', expectedRevision: -1 })).toBe(false);
    expect(isLocalProviderRevisionRequest({ requestId: 'r1', expectedRevision: 1.5 })).toBe(false);
    expect(isLocalProviderRevisionRequest({ requestId: 'r1' })).toBe(false);
    expect(
      isLocalProviderRevisionRequest({ requestId: 'r1', expectedRevision: 1, provider: 'x' }),
    ).toBe(false);
  });

  it('validates the normalized check response', () => {
    expect(isLocalProviderCheckResponse(check)).toBe(true);
    expect(
      isLocalProviderCheckResponse({ status, check: { ...check.check, persisted: 'yes' } }),
    ).toBe(false);
    expect(
      isLocalProviderCheckResponse({ status, check: { ...check.check, outcome: 'error' } }),
    ).toBe(false);
    expect(
      isLocalProviderCheckResponse({
        status,
        check: { ...check.check, outcome: 'cancelled', httpStatus: null },
      }),
    ).toBe(true);
    expect(
      isLocalProviderCheckResponse({ status, check: { ...check.check, httpStatus: 99 } }),
    ).toBe(false);
    expect(isLocalProviderCheckResponse({ status })).toBe(false);
  });
});
