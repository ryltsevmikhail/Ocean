import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { managedLifetimeFingerprint } from '@runnets/domain';
import { managedLifetimeFixture } from '../test-fixtures/managed-lifetime.js';
import { store } from '../test-fixtures/plugin-operation-rig.js';
import { SqliteToolJournal } from './tool-journal.js';
it('requires an exact fresh pending snapshot across two SQLite handles and never exempts an omitted writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-sql-race-')),
    db = store(join(root, 'db'));
  const other = new DatabaseSync(join(root, 'db'));
  try {
    const one = new SqliteToolJournal(db),
      two = new SqliteToolJournal(other);
    const a = managedLifetimeFixture(),
      b = managedLifetimeFixture('b', '/b', '22222222-2222-2222-2222-222222222222');
    const c = managedLifetimeFixture('c', '/c', '33333333-3333-3333-3333-333333333333');
    const claim = (
      j: SqliteToolJournal,
      f: typeof a,
      pairs: Parameters<SqliteToolJournal['claimNow']>[6] = { pairs: [] },
    ) =>
      j.claimNow(
        f.claim.id,
        f.claim.tool,
        f.claim,
        managedLifetimeFingerprint(f.claim),
        f.admission,
        undefined,
        pairs,
      );
    expect(claim(one, a)).toBe(true);
    const row = one.inspectPending()[0]!;
    expect(claim(two, b)).toBe(false);
    expect(
      claim(two, b, {
        pairs: [
          {
            row,
            pair: {
              existing: a.admission,
              incoming: b.admission,
              existingCoordinate: '/a',
              incomingCoordinate: '/b',
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      claim(one, c, {
        pairs: [
          {
            row,
            pair: {
              existing: a.admission,
              incoming: c.admission,
              existingCoordinate: '/a',
              incomingCoordinate: '/c',
            },
          },
        ],
      }),
    ).toBe(false);
    expect(one.inspectPending()).toHaveLength(2);
    db.prepare("INSERT INTO tool_invocations_v1 VALUES('legacy','old','uncertain')").run();
    expect(
      claim(one, c, {
        pairs: one.inspectPending().map((r) => ({
          row: r,
          pair: {
            existing: r.admission ?? a.admission,
            incoming: c.admission,
            existingCoordinate: '/a',
            incomingCoordinate: '/c',
          },
        })),
      }),
    ).toBe(false);
  } finally {
    other.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
