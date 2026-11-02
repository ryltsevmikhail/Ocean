/**
 * Domain errors and the Result envelope. Expected outcomes never throw, so the
 * code, details, and message of every factory are part of the public contract.
 */

import { describe, expect, it } from 'vitest';
import { DomainError, err, ok } from '@runnets/domain';

describe('DomainError', () => {
  it('is a named Error subclass carrying a code and details', () => {
    const error = new DomainError('invalid_argument', 'bad input', { field: 'model' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('invalid_argument');
    expect(error.details).toEqual({ field: 'model' });
    expect(error.message).toBe('bad input');
  });

  it('defaults details to an empty object', () => {
    expect(new DomainError('unknown_event', 'unknown event type').details).toEqual({});
  });

  it('builds invalid_transition errors naming the source state and command', () => {
    const error = DomainError.invalidTransition('running', 'Resume');
    expect(error.code).toBe('invalid_transition');
    expect(error.details).toEqual({ from: 'running', command: 'Resume' });
    expect(error.message).toBe('command Resume is not allowed in state running');
  });

  it('builds version_conflict errors naming both versions', () => {
    const error = DomainError.versionConflict(3, 1);
    expect(error.code).toBe('version_conflict');
    expect(error.details).toEqual({ expected: 3, actual: 1 });
    expect(error.message).toBe('expected version 3, stream is at version 1');
  });

  it('builds terminal_state errors naming the terminal state and command', () => {
    const error = DomainError.terminal('cancelled', 'Complete');
    expect(error.code).toBe('terminal_state');
    expect(error.details).toEqual({ state: 'cancelled', command: 'Complete' });
    expect(error.message).toContain('task run is terminal (cancelled)');
    expect(error.message).toContain('Complete');
  });

  it('builds invariant_violation errors with optional details', () => {
    expect(DomainError.invariant('checkpoint mismatch').code).toBe('invariant_violation');
    expect(DomainError.invariant('checkpoint mismatch').details).toEqual({});
    expect(DomainError.invariant('checkpoint mismatch', { pending: null }).details).toEqual({
      pending: null,
    });
  });

  it('builds invalid_argument errors without details', () => {
    const error = DomainError.invalidArgument('model must not be empty');
    expect(error.code).toBe('invalid_argument');
    expect(error.details).toEqual({});
    expect(error.message).toBe('model must not be empty');
  });
});

describe('Result helpers', () => {
  it('wraps a success value', () => {
    expect(ok(7)).toEqual({ ok: true, value: 7 });
  });

  it('wraps a failure', () => {
    const error = DomainError.invariant('boom');
    const result = err(error);
    expect(result).toEqual({ ok: false, error });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('invariant_violation');
  });
});
