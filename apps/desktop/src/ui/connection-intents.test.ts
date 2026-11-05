import { expect, it } from 'vitest';
import { createConnectionIntents, keylessRecoveryForSelection } from './connection-intents.js';
import { keyless } from './model-settings-recovery.js';
import { metadata } from '../../test-fixtures/model-settings.js';
const original = (id: string, requestId: string) =>
  keyless(
    { op: 'model-remove-key', input: { connectionId: id, requestId, expectedRevision: 1 } },
    id,
  );
it('cannot replace or acknowledge a different original on the same connection', () => {
  const s = createConnectionIntents(),
    a = original('a', 'one'),
    other = original('a', 'two'),
    b = original('b', 'one');
  s.retain(a);
  s.retain(other);
  s.retain(b);
  s.acknowledge(other);
  expect(s.entries.get('a')).toEqual(a);
  expect(s.entries.get('b')).toEqual(b);
  s.acknowledge(a);
  expect(s.entries.has('a')).toBe(false);
  expect(s.entries.get('b')).toEqual(b);
});
it('requires both the selected connection and historical original request ID to match', () => {
  const originalA = original('a', 'one');
  const historical = {
    ...metadata(),
    recovery: { kind: 'original_input_required' as const, pendingRevision: 1, requestId: 'two' },
  };
  expect(keylessRecoveryForSelection(originalA, historical, 'a')).toBe(false);
  expect(
    keylessRecoveryForSelection(
      originalA,
      { ...historical, recovery: { ...historical.recovery, requestId: 'one' } },
      'a',
    ),
  ).toBe(true);
  expect(keylessRecoveryForSelection(originalA, undefined, 'b')).toBe(false);
});
