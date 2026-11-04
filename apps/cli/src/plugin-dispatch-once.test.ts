import { expect, it } from 'vitest';
import { sessionRig } from '../test-fixtures/github-session-rig.js';

it('does not renegotiate a modern catalog or replay a header-mismatch request during invocation', async () => {
  const r = await sessionRig();
  r.controls.modern = true;
  await r.discover();
  r.grant();
  const before = r.observations.length;
  const result = await r.execute();
  expect(r.business()).toHaveLength(1);
  expect(result.isError).toBe(false);
  expect(
    r.observations
      .slice(before)
      .filter((entry) => ['tools/list', 'server/discover'].includes(entry.method)),
  ).toHaveLength(0);
});

it('does not repeat a warm-session HTTP 404 and preserves the observed refusal', async () => {
  const r = await sessionRig();
  await r.discover();
  r.grant();
  expect((await r.execute()).isError).toBe(false);
  r.controls.toolStatus = 404;
  const before = r.observations.length;
  expect((await r.execute()).isError).toBe(true);
  expect(r.business()).toHaveLength(2);
  expect(
    r.observations.slice(before).filter((entry) => entry.method === 'tools/list'),
  ).toHaveLength(0);
  expect(r.runtime.operations?.list().find((entry) => entry.outcomeCode !== 'ok')).toMatchObject({
    state: 'failed',
    outcomeCode: 'vendor_error',
  });
});
