/**
 * Bridge a synchronous database call onto the asynchronous port contract.
 *
 * The work is deferred into a microtask so a synchronous SQLite error becomes a
 * rejected promise instead of escaping the port method. Database access is
 * still synchronous underneath: `node:sqlite` has no async API.
 */
export function toPromise<T>(work: () => T): Promise<T> {
  return Promise.resolve().then(work);
}
