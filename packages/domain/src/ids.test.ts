/**
 * Identity constructors must reject malformed wire values. A rejected identity
 * is programmer error, so constructors throw `RangeError` instead of returning
 * a Result; accepted identities keep their raw value and their brand.
 */

import { describe, expect, it } from 'vitest';
import {
  ID_PREFIX,
  attemptId,
  checkpointId,
  conversationId,
  eventId,
  isValidId,
  policyId,
  processId,
  sideEffectId,
  taskRunId,
  toolInvocationId,
  workspaceId,
} from '@runnets/domain';

type IdConstructor = (raw: string) => string;

/** Every public constructor, the prefix it requires, and its display name. */
const CONSTRUCTORS: ReadonlyArray<
  readonly [kind: string, prefix: string, construct: IdConstructor]
> = [
  ['TaskRunId', 'tr', taskRunId],
  ['AttemptId', 'at', attemptId],
  ['EventId', 'ev', eventId],
  ['ConversationId', 'cv', conversationId],
  ['WorkspaceId', 'ws', workspaceId],
  ['CheckpointId', 'cp', checkpointId],
  ['ToolInvocationId', 'ti', toolInvocationId],
  ['SideEffectId', 'se', sideEffectId],
  ['PolicyId', 'pl', policyId],
  ['ProcessId', 'px', processId],
];

const MALFORMED = [
  '',
  'tr',
  'tr_',
  'tr_0',
  'tr_01',
  'tr-0001',
  'TR_0001',
  'tr_0001!',
  'tr_0001 ',
  `tr_${'a'.repeat(63)}`,
] as const;

describe('ID_PREFIX', () => {
  it('maps every identity kind to its two-letter prefix', () => {
    expect(ID_PREFIX).toEqual({
      taskRun: 'tr',
      attempt: 'at',
      event: 'ev',
      conversation: 'cv',
      workspace: 'ws',
      checkpoint: 'cp',
      toolInvocation: 'ti',
      sideEffect: 'se',
      policy: 'pl',
      process: 'px',
    });
  });
});

describe('id constructors', () => {
  it('accept a well-formed id for every identity kind', () => {
    for (const [, prefix, construct] of CONSTRUCTORS) {
      expect(construct(`${prefix}_0001`)).toBe(`${prefix}_0001`);
    }
  });

  it('accept digits, underscores, and hyphens after the first id character', () => {
    expect(taskRunId('tr_run-1_a')).toBe('tr_run-1_a');
    expect(policyId('pl_a_b-c9')).toBe('pl_a_b-c9');
  });

  it('reject ids whose prefix belongs to another kind', () => {
    for (const [kind, prefix, construct] of CONSTRUCTORS) {
      const foreign = prefix === 'tr' ? 'at_0001' : 'tr_0001';
      expect(() => construct(foreign), `${kind} accepted ${foreign}`).toThrow(RangeError);
      expect(() => construct(foreign)).toThrowError(`invalid ${kind}: expected ${prefix}_<id>`);
    }
  });

  it('reject malformed ids regardless of prefix', () => {
    for (const raw of MALFORMED) {
      expect(isValidId(raw, 'tr'), `isValidId accepted ${JSON.stringify(raw)}`).toBe(false);
      expect(() => taskRunId(raw), `taskRunId accepted ${JSON.stringify(raw)}`).toThrow(RangeError);
    }
  });

  it('name the kind, the expected prefix, and the rejected value in the error', () => {
    expect(() => taskRunId('at_0001')).toThrowError(
      'invalid TaskRunId: expected tr_<id>, received "at_0001"',
    );
  });
});

describe('isValidId', () => {
  it('accepts a value that matches the requested prefix', () => {
    expect(isValidId('tr_0001', 'tr')).toBe(true);
    expect(isValidId('cp_run-1_a', 'cp')).toBe(true);
  });

  it('enforces the 65 character ceiling', () => {
    expect(isValidId(`tr_${'a'.repeat(62)}`, 'tr')).toBe(true);
    expect(isValidId(`tr_${'a'.repeat(63)}`, 'tr')).toBe(false);
  });

  it('rejects a matching shape with the wrong prefix', () => {
    expect(isValidId('tr_0001', 'at')).toBe(false);
    expect(isValidId('tr_0001', 't')).toBe(false);
    expect(isValidId('tr_0001', '')).toBe(false);
  });

  it('rejects uppercase, punctuation, and missing separators', () => {
    expect(isValidId('TR_0001', 'TR')).toBe(false);
    expect(isValidId('tr-0001', 'tr')).toBe(false);
    expect(isValidId('tr_0001!', 'tr')).toBe(false);
    expect(isValidId('tr_ab', 'tr')).toBe(false);
  });
});
