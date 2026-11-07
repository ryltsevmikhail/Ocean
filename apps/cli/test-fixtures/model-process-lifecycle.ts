const cleanups: (() => Promise<void>)[] = [];
let closing: Promise<void> | undefined;
export function ownFixture(cleanup: () => Promise<void>) {
  cleanups.push(cleanup);
}
/** Reap owned direct children before the scenario exits; launcher group kill is the fallback. */
export function closeFixtures(): Promise<void> {
  return (closing ??= (async () => {
    let failed = false;
    while (cleanups.length) {
      try {
        await cleanups.pop()!();
      } catch {
        failed = true;
      }
    }
    if (failed) throw Error('fixture_cleanup_failed');
  })());
}
