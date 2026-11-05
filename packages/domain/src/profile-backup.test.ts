import { expect, it } from 'vitest';
import { validProfileBackupManifest, type ProfileBackupManifest } from './profile-backup.js';
const value: ProfileBackupManifest = {
  format: 2,
  createdAt: '2026-11-03T00:00:00.000Z',
  cli: '1.1.0',
  node: 'v26.13.0',
  sha256: 'a'.repeat(64),
  bytes: 4096,
  summary: {
    schema: 12,
    rooms: 1,
    messages: 0,
    positions: [{ roomId: 'room', sequence: 0 }],
    pendingEffects: 0,
    unfinishedRuns: 0,
    heldRooms: 0,
  },
  assets: {
    catalog: 'a'.repeat(64),
    codingInventory: 'b'.repeat(64),
    desktopInventory: 'c'.repeat(64),
    worktrees: 'd'.repeat(64),
    recovery: 'e'.repeat(64),
    dependencies: 'f'.repeat(64),
    desktop: null,
  },
};
it('distinguishes a complete portable format2 identity from historical format1 metadata', () => {
  expect(validProfileBackupManifest(value)).toBe(true);
  const { assets: _assets, ...body } = value;
  expect(
    validProfileBackupManifest({ ...body, format: 1, summary: { ...body.summary, schema: 5 } }),
  ).toBe(true);
  expect(validProfileBackupManifest({ ...body, format: 2 })).toBe(false);
});
it('accepts schema20 through schema25 backups while refusing unsupported future schemas', () => {
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 21 } })).toBe(
    true,
  );
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 20 } })).toBe(
    true,
  );
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 22 } })).toBe(
    true,
  );
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 23 } })).toBe(
    true,
  );
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 24 } })).toBe(
    true,
  );
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 25 } })).toBe(
    true,
  );
  expect(validProfileBackupManifest({ ...value, summary: { ...value.summary, schema: 26 } })).toBe(
    false,
  );
});
it('rejects coerced versions, unbounded counters, duplicate room positions and unknown format2 claims', () => {
  for (const malformed of [
    { ...value, format: '2' },
    { ...value, bytes: 2147483649 },
    { ...value, automaticRebind: true },
    { ...value, summary: { ...value.summary, messages: -1 } },
    {
      ...value,
      summary: {
        ...value.summary,
        positions: [...value.summary.positions, ...value.summary.positions],
      },
    },
    {
      ...value,
      summary: { ...value.summary, positions: [{ roomId: 'room', sequence: 0, authority: true }] },
    },
    { ...value, assets: { ...value.assets, desktop: 'unsupported' } },
  ])
    expect(validProfileBackupManifest(malformed)).toBe(false);
});
