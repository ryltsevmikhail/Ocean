/**
 * @runnets/domain — pure domain model.
 *
 * No I/O, no async, no storage, no transport, no provider SDK. Everything here
 * is a deterministic function of committed events and command input, so the
 * same tests prove the same behavior in every host.
 */

export * from './ids.js';
export * from './errors.js';
export * from './events.js';
export * from './commands.js';
export * from './state.js';
export * from './decide.js';
export * from './evolve.js';
export * from './budget.js';
export * from './side-effect.js';
