import { expect, it } from 'vitest';
import { recoveryCommand } from './model-settings-recovery.js';
import type { LocalModelPendingRequest } from '../model-protocol.js';
it('preserves legacy omission, original method, UUID and exact input', () => {
  const original: LocalModelPendingRequest = {
    version: 1,
    operation: {
      method: 'provider.set',
      input: { requestId: 'original', model: 'm' },
      keyWasSupplied: true,
    },
  };
  expect(recoveryCommand(original, 'same')).toEqual({
    op: 'provider-set',
    requestId: 'original',
    model: 'm',
    key: 'same',
  });
  expect(recoveryCommand(original, 'same')).not.toHaveProperty('expectedRevision');
  expect(() => recoveryCommand(original, '')).toThrow('key_resupply_required');
});
it('keeps null versus numeric guard and rejects keys on keyless original operations', () => {
  const original: LocalModelPendingRequest = {
    version: 1,
    operation: {
      method: 'modelConnections.set',
      input: {
        connectionId: 'a',
        requestId: 'uuid',
        expectedRevision: null,
        providerId: 'ollama',
        kind: 'local',
        endpoint: 'http://127.0.0.1:11434',
        auth: 'none',
        defaultModelId: 'qwen3:1.7b',
      },
      keyWasSupplied: false,
    },
  };
  expect(recoveryCommand(original, '')).toEqual({
    op: 'model-set',
    input: original.operation.input,
  });
  expect(() => recoveryCommand(original, 'accidental')).toThrow('invalid_request');
  const remove: LocalModelPendingRequest = {
    version: 1,
    operation: {
      method: 'modelConnections.removeSavedKey',
      input: { connectionId: 'a', requestId: 'same', expectedRevision: 3 },
    },
  };
  expect(recoveryCommand(remove, '')).toEqual({
    op: 'model-remove-key',
    input: remove.operation.input,
  });
});
