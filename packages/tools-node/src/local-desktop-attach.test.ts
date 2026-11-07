import { expect, it } from 'vitest';
import { DesktopAttachmentClient, localDesktopClient } from './local-desktop-client.js';
function fixture(replies: readonly unknown[]) {
  const calls: unknown[] = [];
  const client = new DesktopAttachmentClient(
    localDesktopClient(async (method, command) => {
      calls.push({ method, command });
      const next = replies[calls.length - 1];
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  return { client, calls };
}
const attach = { op: 'attach', ok: true },
  enroll = { op: 'enroll', ok: true };
it('attaches without submitting a new legacy origin', async () => {
  const f = fixture([attach]);
  await f.client.connect('/new-userData');
  expect(f.calls).toEqual([{ method: 'desktop.assets', command: { op: 'attach' } }]);
});
it.each(['desktop_not_enrolled', 'invalid_params'])(
  'enrolls once only after explicit %s',
  async (code) => {
    const f = fixture([Error(code), enroll]);
    await f.client.connect('/fresh');
    expect(f.calls).toEqual([
      { method: 'desktop.assets', command: { op: 'attach' } },
      { method: 'desktop.assets', command: { op: 'enroll', userData: '/fresh' } },
    ]);
  },
);
it('reads the winner once after concurrent first-enrollment conflict', async () => {
  const f = fixture([Error('desktop_not_enrolled'), Error('desktop_binding_conflict'), attach]);
  await f.client.connect('/loser');
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2]).toEqual({ method: 'desktop.assets', command: { op: 'attach' } });
});
it.each([
  'desktop_outcome_unknown',
  'desktop_binding_mismatch',
  'connection_closed',
  'runtime_timeout',
])('does not write after attach %s', async (code) => {
  const f = fixture([Error(code)]);
  await expect(f.client.connect('/new')).rejects.toThrow(code);
  expect(f.calls).toHaveLength(1);
});
it.each([
  'desktop_outcome_unknown',
  'desktop_binding_mismatch',
  'connection_closed',
  'invalid_params',
])('never repeats an enrollment on %s', async (code) => {
  const f = fixture([Error('desktop_not_enrolled'), Error(code)]);
  await expect(f.client.connect('/new')).rejects.toThrow(code);
  expect(f.calls).toHaveLength(2);
});
it.each([
  null,
  { op: 'attach', ok: false },
  { op: 'enroll', ok: true },
  { ...attach, root: '/secret' },
])('does not enroll on malformed attach reply %j', async (reply) => {
  const f = fixture([reply]);
  await expect(f.client.connect('/new')).rejects.toThrow('invalid_frame');
  expect(f.calls).toHaveLength(1);
});
it('fails closed if the race winner cannot be read', async () => {
  const f = fixture([
    Error('desktop_not_enrolled'),
    Error('desktop_binding_conflict'),
    Error('desktop_binding_mismatch'),
  ]);
  await expect(f.client.connect('/new')).rejects.toThrow('desktop_binding_mismatch');
  expect(f.calls).toHaveLength(3);
});

it('retains an older peer enrollment conflict without unsupported attach retries', async () => {
  const f = fixture([Error('invalid_params'), Error('desktop_binding_conflict')]);
  await expect(f.client.connect('/other')).rejects.toThrow('desktop_binding_conflict');
  expect(f.calls).toHaveLength(2);
});
