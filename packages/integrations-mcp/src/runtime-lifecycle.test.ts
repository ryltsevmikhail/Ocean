import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { composeRuntimeServices } from '../../../apps/cli/src/runtime-services.js';
import { httpFixture } from './prototype-http-fixture.js';
import { admission, connection } from '../test-fixtures/admission.js';
import { createMcpServiceTransport } from './index.js';
it('only explicit start discovers and runtime drain joins held metadata without closing its store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neutral-lifecycle-'));
  const f = await httpFixture('normal');
  const disabled = createMcpServiceTransport({});
  const c = connection({ kind: 'http', url: f.url.href });
  const a = admission(join(dir, 'db'), c, disabled);
  const original = globalThis.fetch;
  let entered = false,
    release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const body = args[1]?.body;
    if (typeof body === 'string' && body.includes('tools/list')) {
      entered = true;
      await held;
    }
    return original(...args);
  });
  const runtime = composeRuntimeServices({
    profile: dir,
    store: a.store,
    ownerId: 'owner',
    restored: false,
    clock: { now: () => new Date() },
  });
  try {
    expect(f.rows).toEqual([]);
    const starting = runtime.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    const closing = runtime.drain();
    expect(await Promise.race([closing.then(() => true), delay(30, false)])).toBe(false);
    expect(a.authority.atomic((tx) => tx.connection(c.id)?.configRevision)).toBe(2);
    release();
    await starting;
    expect(await closing).toBe('settled');
    expect(f.stats.calls).toBe(0);
    expect(a.authority.atomic((tx) => tx.connection(c.id)?.currentCatalogId)).toBeNull();
  } finally {
    release();
    spy.mockRestore();
    await runtime.drain();
    await disabled.close();
    a.store.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
