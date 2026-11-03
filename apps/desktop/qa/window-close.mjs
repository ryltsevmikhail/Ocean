import { clearTimeout, setTimeout } from 'node:timers';

// Evaluation may lose its context, reject, or hang. Only the close event proves closure.
export async function closePage(page, timeoutMs = 10000) {
  const { promise, resolve, reject } = Promise.withResolvers();
  page.once('close', resolve);
  const timer = setTimeout(() => reject(Error('Desktop page close timed out')), timeoutMs);
  try {
    void page.evaluate(() => globalThis.close()).catch(() => {});
    await promise;
  } finally {
    clearTimeout(timer);
    page.removeListener('close', resolve);
  }
}
