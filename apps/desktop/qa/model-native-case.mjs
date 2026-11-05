import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import { bounded } from './current-window.mjs';

// One cooperative flow. Its SDK peer and GUI are owned by the session supplied to retire().
export function createNativeCase() {
  const abort = new globalThis.AbortController();
  const { signal } = abort;
  const failed = Promise.withResolvers();
  let used = false,
    finished = false,
    deadline = Infinity;
  function fail(error) {
    if (signal.aborted) return;
    abort.abort(error);
    failed.resolve();
  }
  function step(issue) {
    if (performance.now() >= deadline) fail(Error('native settings flow timed out'));
    signal.throwIfAborted();
    if (finished) throw Error('native case finished');
    return issue();
  }
  async function run(work, ms, retire) {
    signal.throwIfAborted();
    if (used) throw Error('native case already used');
    if (!Number.isInteger(ms) || ms < 1 || ms > 2147483647)
      throw Error('invalid native case deadline');
    used = true;
    deadline = performance.now() + ms;
    const timer = setTimeout(() => fail(Error('native settings flow timed out')), ms);
    const flow = Promise.resolve().then(() => step(() => work(step)));
    try {
      const result = await Promise.race([flow, failed.promise]);
      step(() => {});
      return result;
    } catch (error) {
      if (!signal.aborted) throw error;
      const original = signal.reason;
      // Closing a connection does not establish the outcome of an in-flight mutation.
      try {
        await retire(original);
      } catch (cleanup) {
        if (cleanup !== original) original.cleanupError = cleanup;
      }
      try {
        await bounded(
          flow.catch(() => {}),
          3000,
          'interrupted native flow drain',
        );
      } catch (drain) {
        original.drainError = drain;
      }
      throw original;
    } finally {
      clearTimeout(timer);
      finished = true;
    }
  }
  return { signal, fail, run };
}
