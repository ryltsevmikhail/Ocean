/** Typed, value-free failures of the execution-disabled plugin setup seam. */

export type ExecutorSetupFailureCode =
  | 'invalid_options'
  | 'invalid_input'
  | 'credential_unavailable'
  | 'pinned_chunk_mismatch'
  | 'setup_failed'
  | 'setup_closed';

export class ExecutorSetupError extends Error {
  readonly code: ExecutorSetupFailureCode;
  constructor(code: ExecutorSetupFailureCode, message: string) {
    super(message);
    this.name = 'ExecutorSetupError';
    this.code = code;
  }
}
