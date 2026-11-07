import { expect, it } from 'vitest';
import * as domain from './index.js';

it.each(['local', 'cloud', 'unknown'] as const)(
  'allow admits %s and deny admits only local',
  (identity) => {
    const admit = domain.admitModelTransfer;
    expect(admit).toBeTypeOf('function');
    expect(admit({ roomId: 'room', cloudTransfer: 'allow', revision: 1 }, identity)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(admit({ roomId: 'room', cloudTransfer: 'deny', revision: 2 }, identity)).toMatchObject(
      identity === 'local' ? { ok: true } : { ok: false, error: { code: 'model_transfer_denied' } },
    );
  },
);
it('refuses missing or malformed authoritative policy even for local', () => {
  const admit = domain.admitModelTransfer;
  expect(admit).toBeTypeOf('function');
  for (const policy of [
    null,
    {},
    { roomId: 'r', cloudTransfer: ['allow'], revision: 1 },
    { roomId: 'r', cloudTransfer: 'allow', revision: 0 },
  ])
    expect(admit(policy as never, 'local')).toMatchObject({
      ok: false,
      error: { code: 'model_policy_unavailable' },
    });
});
