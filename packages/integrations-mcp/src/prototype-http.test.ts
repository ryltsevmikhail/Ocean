import { accountCase } from './prototype-accounts.js';
import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpCases, runHttpCase } from './prototype-http.js';

const lifetimeCases = [
  ['held-timeout', 1, 0, 0, 'not_started'],
  ['held-abort', 1, 0, 0, 'not_started'],
  ['held-concurrent', 2, 1, 0, 'not_started'],
  ['status-race', 2, 2, 1, 'uncertain'],
] as const;
it.each(httpCases.filter((name) => !lifetimeCases.some(([scenario]) => scenario === name)))(
  'measures %s independently of server acceptance',
  async (name) => {
    const result = await runHttpCase(name);
    expect(result, result.detail).toMatchObject({ status: 'passed' });
    if (name === 'drop' || name === 'timeout') {
      expect(result.businessAttempts).toBe(1);
      expect(result.observedEffects).toBe(1);
      expect(result.outcome).toBe('uncertain');
    }
    if (name === 'revoked') expect(result.businessAttempts).toBe(0);
  },
  10000,
);

it('keeps frozen definitions on their admitting account', async () => {
  const r = await accountCase();
  expect(r, r.detail).toMatchObject({ status: 'passed' });
});

it.each(lifetimeCases)(
  'drains the actual %s writer and checks its send receipts',
  async (name, sdkAttempts, businessAttempts, observedEffects, outcome) => {
    const dir = await mkdtemp(join(tmpdir(), 'ocean-held-'));
    const path = join(dir, 'dispatches');
    try {
      const result = await runHttpCase(name, path);
      expect(result, result.detail).toMatchObject({
        status: 'passed',
        sdkAttempts,
        businessAttempts,
        observedEffects,
        outcome,
      });
      const details = JSON.parse(result.detail) as {
        protocol: string;
        concurrentOutcome: string | null;
        concurrentStatus?: number;
        wire: string[];
        httpStatus: number;
      };
      expect(details.protocol).toBe('2025-11-25');
      expect(details.wire.filter((method) => method === 'tools/call')).toHaveLength(
        businessAttempts,
      );
      if (sdkAttempts === 2)
        expect(details).toMatchObject({
          concurrentOutcome: 'observed',
          concurrentStatus: 401,
          httpStatus: 0,
        });
      if (businessAttempts === 0)
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(path, 'utf8')).toBe((name + '\n').repeat(businessAttempts));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
