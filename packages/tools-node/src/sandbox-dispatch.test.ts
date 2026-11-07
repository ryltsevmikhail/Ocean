import { it, expect } from 'vitest';
import { sendSandboxPayload } from './sandbox-supervision.js';
it.each(['revoke', 'closed', 'abort', 'send'] as const)(
  'gates the actual worker payload after suspended preparation: %s',
  async (mode) => {
    let release!: () => void,
      active = true,
      authorized = true,
      writes = 0;
    const c = new AbortController();
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sending = sendSandboxPayload(
      { signal: c.signal, guard: { prepare: () => gate, authorize: () => authorized } },
      () => active,
      () => {
        writes++;
      },
    );
    if (mode === 'revoke') authorized = false;
    if (mode === 'closed') active = false;
    if (mode === 'abort') c.abort();
    release();
    expect(await sending).toBe(mode === 'send');
    expect(writes).toBe(mode === 'send' ? 1 : 0);
  },
);
