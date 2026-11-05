import { accountCase } from './prototype-accounts.js';
import { expect, it } from 'vitest';
import { httpCases, runHttpCase } from './prototype-http.js';

it.each(httpCases)(
  'measures %s independently of server acceptance',
  async (name) => {
    const result = await runHttpCase(name);
    expect(result, result.detail).toMatchObject({ status: 'passed' });
    if (name === 'drop') {
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
