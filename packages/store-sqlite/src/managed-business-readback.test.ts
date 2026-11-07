import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  managedLifetimeFingerprint,
  type ServiceJson,
  type ToolEffectAdmission,
} from '@runnets/domain';
import { managedLifetimeFixture } from '../test-fixtures/managed-lifetime.js';
import { store } from '../test-fixtures/plugin-operation-rig.js';
import { managedBusinessFingerprint } from './managed-journal-evidence.js';
import { SqliteToolJournal } from './tool-journal.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-business-')),
    path = join(root, 'db'),
    db = store(path),
    journal = new SqliteToolJournal(db),
    f = managedLifetimeFixture();
  expect(
    journal.claimNow(
      f.claim.id,
      f.claim.tool,
      f.claim,
      managedLifetimeFingerprint(f.claim),
      f.admission,
    ),
  ).toBe(true);
  const own = journal.inspectPending()[0]!;
  const binding = { ...(f.admission.binding as Record<string, ServiceJson>) };
  delete binding['managedLifetime'];
  const admission: ToolEffectAdmission = {
    ...f.admission,
    grantReference: { grantId: 'grant', revision: 1 },
    binding: {
      ...binding,
      managedSession: own.fingerprint,
      configRevision: 1,
      trustRevision: 1,
      credentialRevision: 1,
      catalogId: 'catalog',
      tool: 'write',
    },
  };
  expect(
    journal.claimNow(
      'business',
      'write',
      { taskRunId: 'run', attemptId: 'at' },
      'immutable-request',
      admission,
      undefined,
      { pairs: [], own },
    ),
  ).toBe(true);
  journal.settleNow('business', 'uncertain', { taskRunId: 'run', attemptId: 'at' });
  journal.settleNow(own.id, 'completed', own);
  return {
    db,
    own,
    admission,
    reopen() {
      db.close();
      const read = new DatabaseSync(path);
      try {
        return new SqliteToolJournal(read).inspectPending().find((row) => row.id === 'business')
          ?.admission;
      } finally {
        read.close();
      }
    },
    close() {
      if (db.isOpen) db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it.each([
  'missing-session',
  'missing-enrollment',
  'missing-workspace',
  'foreign-workspace',
  'foreign-session',
  'missing-life',
  'contradictory-life',
  'fingerprint',
  'identity',
] as const)('reopens %s ordinary managed evidence as global unknown', (mode) => {
  const f = fixture();
  try {
    const admission = structuredClone(f.admission),
      b = admission.binding as Record<string, ServiceJson>;
    if (mode.startsWith('missing-') && mode !== 'missing-life')
      delete b[
        {
          'missing-session': 'managedSession',
          'missing-enrollment': 'managedEnrollment',
          'missing-workspace': 'managedWorkspace',
        }[mode as 'missing-session']!
      ];
    else if (mode === 'foreign-workspace')
      b['managedWorkspace'] = (
        managedLifetimeFixture('b', '/b').admission.binding as Record<string, ServiceJson>
      )['managedWorkspace']!;
    else if (mode === 'foreign-session') b['managedSession'] = 'b'.repeat(64);
    else if (mode === 'missing-life')
      f.db.prepare('DELETE FROM tool_invocations_v2 WHERE id=?').run(f.own.id);
    else if (mode === 'contradictory-life')
      f.db.prepare("UPDATE tool_invocations_v2 SET outcome='not_started' WHERE id=?").run(f.own.id);
    else if (mode === 'fingerprint')
      f.db
        .prepare("UPDATE tool_invocations_v2 SET fingerprint=? WHERE id='business'")
        .run('f'.repeat(64));
    else f.db.prepare("UPDATE tool_invocations_v2 SET tool='other' WHERE id='business'").run();
    f.db
      .prepare("UPDATE tool_invocations_v2 SET admission=? WHERE id='business'")
      .run(JSON.stringify(admission));
    expect(f.reopen()).toBeUndefined();
  } finally {
    f.close();
  }
});
it.each(['completed', 'uncertain'] as const)(
  'retains valid business scope against a %s historical lifetime',
  (outcome) => {
    const f = fixture();
    try {
      f.db.prepare('UPDATE tool_invocations_v2 SET outcome=? WHERE id=?').run(outcome, f.own.id);
      expect(f.reopen()).toEqual(f.admission);
    } finally {
      f.close();
    }
  },
);
it('refuses an incomplete managed marker at insertion even with no pending lifecycle', () => {
  const db = store(),
    journal = new SqliteToolJournal(db),
    f = managedLifetimeFixture();
  const admission = {
    ...f.admission,
    grantReference: { grantId: 'grant', revision: 1 },
    binding: {
      connectionId: 'a',
      managedWorkspace: (f.admission.binding as Record<string, ServiceJson>)['managedWorkspace']!,
    },
  };
  expect(
    journal.claimNow(
      'partial',
      'write',
      { taskRunId: 'run', attemptId: 'at' },
      'partial',
      admission,
    ),
  ).toBe(false);
});

it.each(['connection', 'enrollment', 'footprint'] as const)(
  'rejects an intact business seal referring to a valid but contradictory historical %s',
  (mode) => {
    const f = fixture(),
      nonce = '22222222-2222-2222-2222-222222222222';
    try {
      const foreign = managedLifetimeFixture(
        mode === 'connection' ? 'b' : 'a',
        mode === 'enrollment' ? '/b' : '/a',
        nonce,
      );
      if (mode === 'footprint')
        (
          (foreign.admission.binding as Record<string, ServiceJson>)['managedWorkspace'] as Record<
            string,
            ServiceJson
          >
        )['ino'] = '99';
      const fingerprint = createHash('sha256')
        .update(managedLifetimeFingerprint(foreign.claim))
        .digest('hex');
      f.db
        .prepare(
          "INSERT INTO tool_invocations_v2(id,tool,task_run_id,attempt_id,fingerprint,outcome,admission) VALUES(?,?,?,?,?,'completed',?)",
        )
        .run(
          nonce,
          foreign.claim.tool,
          foreign.claim.taskRunId,
          nonce,
          fingerprint,
          JSON.stringify(foreign.admission),
        );
      const admission = structuredClone(f.admission);
      (admission.binding as Record<string, ServiceJson>)['managedSession'] = fingerprint;
      const seal = managedBusinessFingerprint(
        { id: 'business', tool: 'write', taskRunId: 'run', attemptId: 'at' },
        admission,
        'immutable-request',
      );
      f.db
        .prepare("UPDATE tool_invocations_v2 SET fingerprint=?,admission=? WHERE id='business'")
        .run(seal, JSON.stringify(admission));
      expect(f.reopen()).toBeUndefined();
    } finally {
      f.close();
    }
  },
);
