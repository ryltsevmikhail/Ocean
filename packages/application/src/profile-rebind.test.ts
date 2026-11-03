import { expect, it } from 'vitest';
import { rebindFixture as fixture } from '../test-fixtures/profile-rebind.test.js';
it('uses the common exact decision and persists intent before preparing only a fresh successor', async () => {
  const f = fixture();
  const card = await f.service?.preview(f.input);
  expect(card?.kind).toBe('restore-rebind');
  expect(f.effects()).toBe(0);
  await f.owner.resolve(card!, card!.bindingDigest, card!.version, 'allow-once');
  await f.service!.join();
  const result = f.service!.result(f.input);
  expect(result.state).toBe('ready');
  expect(result.result?.task.id).not.toBe(f.old.id);
  expect(result.result?.task.lease.ownerId).not.toBe(f.old.lease.ownerId);
  expect(f.effects()).toBe(1);
  expect(f.published()).toBe(true);
  await f.service!.preview(f.input);
  await f.owner.resolve(card!, card!.bindingDigest, card!.version, 'allow-once');
  expect(f.effects()).toBe(1);
  expect(f.old.projectRoot).toBe('/old');
});
it('denial cannot create an epoch lease or materialize recovered bytes', async () => {
  const f = fixture(),
    card = await f.service?.preview(f.input);
  expect(card?.kind).toBe('restore-rebind');
  await f.owner.resolve(card!, card!.bindingDigest, card!.version, 'deny');
  await f.service!.join();
  expect(f.service!.result(f.input)).toMatchObject({
    state: 'refused',
    projectLease: null,
    worktreeLease: null,
    result: null,
  });
  expect(f.effects()).toBe(0);
  expect(f.published()).toBe(false);
});
it('changed inputs during exact confirmation invalidate the one-use preview', async () => {
  const f = fixture(),
    card = await f.service?.preview(f.input);
  expect(card?.kind).toBe('restore-rebind');
  f.change();
  expect(
    (await f.owner.resolve(card!, card!.bindingDigest, card!.version, 'allow-once')).status,
  ).toBe('invalidated');
  await f.service!.join();
  expect(f.effects()).toBe(0);
  expect(f.published()).toBe(false);
});
