/**
 * Typed domain errors.
 *
 * The domain never throws for expected outcomes: commands return a `Result`.
 * Exceptions remain possible only for programmer error (invalid identity,
 * malformed event stream).
 */

export type DomainErrorCode =
  | 'invalid_transition'
  | 'version_conflict'
  | 'terminal_state'
  | 'invariant_violation'
  | 'unknown_event'
  | 'invalid_argument';

export interface DomainErrorDetails {
  readonly [key: string]: string | number | boolean | null;
}

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: DomainErrorDetails;

  constructor(code: DomainErrorCode, message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  static invalidTransition(from: string, command: string): DomainError {
    return new DomainError(
      'invalid_transition',
      `command ${command} is not allowed in state ${from}`,
      { from, command },
    );
  }

  static versionConflict(expected: number, actual: number): DomainError {
    return new DomainError(
      'version_conflict',
      `expected version ${expected}, stream is at version ${actual}`,
      { expected, actual },
    );
  }

  static terminal(state: string, command: string): DomainError {
    return new DomainError(
      'terminal_state',
      `task run is terminal (${state}); command ${command} is rejected`,
      { state, command },
    );
  }

  static invariant(message: string, details: DomainErrorDetails = {}): DomainError {
    return new DomainError('invariant_violation', message, details);
  }

  static invalidArgument(message: string): DomainError {
    return new DomainError('invalid_argument', message);
  }
}

export type Result<TValue, TError = DomainError> =
  { readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

export const ok = <TValue>(value: TValue): Result<TValue, never> => ({ ok: true, value });

export const err = <TError>(error: TError): Result<never, TError> => ({ ok: false, error });
