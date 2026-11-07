import { expect, it } from 'vitest';
import type { OwnerScopeIntent } from '@runnets/application';
import { validServiceGrantSetRequest } from '@runnets/domain';
import { rig } from '../test-fixtures/service-call-rig.js';
it.each([null, undefined, 'unknown'])(
  'refuses present %s mode at wire and shared owner policy boundaries',
  (mode) => {
    const f = rig(async () => {
      throw Error('unused');
    });
    try {
      const bad = { ...f.intent, id: 'malformed', mode } as unknown as OwnerScopeIntent;
      expect(
        validServiceGrantSetRequest({ requestId: 'invalid', expectedRevision: null, intent: bad }),
      ).toBe(false);
      expect(() => f.owners.issue(bad)).toThrow('invalid_owner_intent');
      expect(f.authority.atomic((tx) => tx.grant('malformed'))).toBeNull();
      const before = f.authority.atomic((tx) => tx.grant('grant'));
      expect(() =>
        f.owners.revise({ grantId: 'grant', revision: 1 }, { ...bad, id: 'grant' }),
      ).toThrow('invalid_owner_intent');
      expect(f.authority.atomic((tx) => tx.grant('grant'))).toEqual(before);
      expect(
        f.owners.revise({ grantId: 'grant', revision: 1 }, { ...f.intent, mode: 'confirm' }).mode,
      ).toBe('confirm');
    } finally {
      if (f.db.isOpen) f.db.close();
    }
  },
);
