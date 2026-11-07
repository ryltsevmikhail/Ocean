import { expect, it } from 'vitest';
import { SessionWriter } from './session-writer.js';
it('joins cancelled preclaim preparation and actual descriptor close through the existing work drain', async () => {
  const ac = new AbortController();
  const writer = new SessionWriter(
    ac.signal,
    { signal: ac.signal, deadlineMs: 1000, authorizeMetadata: () => true },
    {},
  );
  let release!: () => void,
    close!: () => void,
    entered!: () => void,
    drained = false;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    closing = new Promise<void>((r) => {
      close = r;
    }),
    seen = new Promise<void>((r) => {
      entered = r;
    });
  const preparation = writer.ownResources(async () => {
    entered();
    await held;
    return { facts: { pairs: [] }, inspect: () => true, close: () => closing };
  });
  await seen;
  ac.abort();
  const drain = writer.afterWork().then(() => {
    drained = true;
  });
  try {
    await new Promise<void>((r) => setImmediate(r));
    expect(drained).toBe(false);
    release();
    const proof = await preparation;
    const closed = proof.close();
    await new Promise<void>((r) => setImmediate(r));
    expect(drained).toBe(false);
    close();
    await closed;
    await drain;
    expect(drained).toBe(true);
  } finally {
    release();
    close();
    await (await preparation).close();
    await drain;
  }
});
