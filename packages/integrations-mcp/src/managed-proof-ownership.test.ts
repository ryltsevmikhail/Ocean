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

it.each(['cancelled', 'expired'] as const)(
  'retains the existing sixteen preparation slots through %s callers and actual late close',
  async (mode) => {
    const owner = new AbortController(),
      writer = new SessionWriter(
        owner.signal,
        { signal: owner.signal, deadlineMs: 1000, authorizeMetadata: () => true },
        {},
      );
    let release!: () => void,
      close!: () => void,
      entered = 0,
      closeEntered = 0,
      drained = false;
    const held = new Promise<void>((r) => {
        release = r;
      }),
      closing = new Promise<void>((r) => {
        close = r;
      });
    const cancellations = Array.from({ length: 16 }, () => new AbortController());
    const signals = cancellations.map((c) =>
      mode === 'expired' ? AbortSignal.timeout(10) : c.signal,
    );
    const preparations = signals.map((_signal, index) =>
      writer.ownResources(async () => {
        entered++;
        await held;
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: async () => {
            closeEntered++;
            await closing;
            if (index === 0) throw Error('late proof close rejection');
          },
        };
      }),
    );
    const callers = preparations.map((preparing, n) =>
      Promise.race([
        preparing.then(() => 'prepared'),
        new Promise<string>((r) =>
          signals[n]!.addEventListener('abort', () => r('refused'), { once: true }),
        ),
      ]),
    );
    if (mode === 'cancelled') cancellations.forEach((c) => c.abort());
    const all = [...preparations];
    const excess = () => {
      const item = writer.ownResources(async () => {
        entered++;
        return { facts: { pairs: [] }, inspect: () => true, close: () => {} };
      });
      all.push(item);
      return item;
    };
    const drain = writer.afterWork().then(() => {
      drained = true;
    });
    try {
      expect(await Promise.all(callers)).toEqual(Array(16).fill('refused'));
      expect(entered).toBe(16);
      expect(drained).toBe(false);
      await expect(excess()).rejects.toThrow('preparation');
      expect(entered).toBe(16);
      const other = new SessionWriter(
        owner.signal,
        { signal: owner.signal, deadlineMs: 1000, authorizeMetadata: () => true },
        {},
      );
      const separate = await other.ownResources(async () => ({
        facts: { pairs: [] },
        inspect: () => true,
        close: () => {},
      }));
      await separate.close();
      await other.afterWork();
      release();
      const proofs = await Promise.all(preparations),
        closes = proofs.map((v) => v.close());
      await new Promise<void>((r) => setImmediate(r));
      expect(closeEntered).toBe(16);
      expect(drained).toBe(false);
      await expect(excess()).rejects.toThrow('preparation');
      expect(entered).toBe(16);
      close();
      const closed = await Promise.allSettled(closes);
      expect(closed.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await drain;
      expect(drained).toBe(true);
      const fresh = await writer.ownResources(async () => {
        entered++;
        return { facts: { pairs: [] }, inspect: () => true, close: () => {} };
      });
      await fresh.close();
      await writer.afterWork();
      expect(entered).toBe(17);
    } finally {
      release();
      close();
      const ready = await Promise.allSettled(all);
      await Promise.allSettled(
        ready.flatMap((r) => (r.status === 'fulfilled' ? [r.value.close()] : [])),
      );
      await drain;
    }
  },
);
it('holds preparation reservations through actual asynchronous rejection and then admits fresh work', async () => {
  const signal = new AbortController().signal,
    writer = new SessionWriter(
      signal,
      { signal, deadlineMs: 1000, authorizeMetadata: () => true },
      {},
    );
  let release!: () => void,
    entered = 0;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const pending = Array.from({ length: 16 }, () =>
    writer.ownResources(async () => {
      entered++;
      await held;
      throw Error('late preparation rejection');
    }),
  );
  const joined = Promise.allSettled(pending);
  let extra: ReturnType<SessionWriter['ownResources']> | undefined;
  try {
    extra = writer.ownResources(async () => {
      entered++;
      return { facts: { pairs: [] }, inspect: () => true, close: () => {} };
    });
    await expect(extra).rejects.toThrow('preparation');
    expect(entered).toBe(16);
  } finally {
    release();
    await joined;
    if (extra)
      await extra.then(
        (v) => v.close(),
        () => {},
      );
    await writer.afterWork();
  }
  const fresh = await writer.ownResources(async () => ({
    facts: { pairs: [] },
    inspect: () => true,
    close: () => {},
  }));
  await fresh.close();
  await writer.afterWork();
});
