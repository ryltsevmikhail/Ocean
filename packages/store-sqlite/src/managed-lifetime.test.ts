import { expect, it } from 'vitest';
import { serviceConnection } from '../../../test-fixtures/service-authority.js';
import {
  managedEnrollment,
  managedLifetimeFingerprint,
  canonicalJson,
  MANAGED_LIFETIME_RUN,
  MANAGED_LIFETIME_TOOL,
  type ToolEffectAdmission,
  type ServiceJson,
} from '@runnets/domain';
import { serviceResourceConflicts } from '@runnets/application';
import { SqliteToolJournal } from './tool-journal.js';
import { store } from '../test-fixtures/plugin-operation-rig.js';
const nonce = '11111111-1111-1111-1111-111111111111';
const unit = 'ocean-mcp-' + 'a'.repeat(32) + '-' + nonce + '.service';
const enrollment = managedEnrollment({
  ...serviceConnection,
  credentialReference: null,
  id: 'a',
  configuration: {
    kind: 'stdio',
    executable: '/server.mjs',
    sha256: 'a'.repeat(64),
    args: [],
    workspaceRoot: '/a',
  },
});
const a: ToolEffectAdmission = {
  scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: 'a' }] },
  effectKind: 'mutation',
  grantReference: null,
  binding: {
    connectionId: 'a',
    managedEnrollment: enrollment,
    managedWorkspace: {
      version: 1,
      root: '/a',
      boot: nonce,
      mountNamespace: 'mnt:[1]',
      mountId: '1',
      dev: '1',
      ino: '1',
      anchor: 'linux-btrfs-v1:' + 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':1:1:01',
    },
    managedLifetime: {
      version: 1,
      nonce,
      unit,
      cgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit,
      enrollment,
    },
  },
};
it('allows only the exact live lifetime when claiming business authority; uncertain stays held', async () => {
  const journal = new SqliteToolJournal(store());
  expect(
    journal.claimNow(
      nonce,
      MANAGED_LIFETIME_TOOL,
      { taskRunId: MANAGED_LIFETIME_RUN, attemptId: nonce },
      managedLifetimeFingerprint({
        id: nonce,
        tool: MANAGED_LIFETIME_TOOL,
        taskRunId: MANAGED_LIFETIME_RUN,
        attemptId: nonce,
        admission: a,
      }),
      a,
    ),
  ).toBe(true);
  const row = journal.inspectPending()[0]!;
  const binding = { ...(a.binding as Record<string, ServiceJson>) };
  delete binding['managedLifetime'];
  const incoming = {
    ...a,
    grantReference: { grantId: 'grant', revision: 1 },
    binding: {
      ...binding,
      managedSession: row.fingerprint,
      configRevision: 1,
      trustRevision: 1,
      credentialRevision: 1,
      tool: 'write',
    },
  };
  expect(serviceResourceConflicts(row, incoming, { pairs: [], own: row })).toBe(false);
  expect(
    serviceResourceConflicts({ ...row, outcome: 'uncertain' }, incoming, { pairs: [], own: row }),
  ).toBe(true);
  expect(
    journal.claimNow(
      'business',
      'write',
      { taskRunId: 'run', attemptId: 'at' },
      'business',
      incoming,
      undefined,
      { pairs: [], own: row },
    ),
  ).toBe(true);
  expect(
    journal.claimNow(
      'second',
      'write',
      { taskRunId: 'run', attemptId: 'at' },
      'second',
      incoming,
      undefined,
      { pairs: [], own: row },
    ),
  ).toBe(false);
  await journal.recover(nonce, row);
  expect(journal.inspectPending().find((r) => r.id === nonce)?.outcome).toBe('uncertain');
  expect(canonicalJson(a)).not.toContain(MANAGED_LIFETIME_RUN);
});
it('downgrades a lifecycle with contradictory printable journal identity to global unknown', () => {
  const db = store(),
    journal = new SqliteToolJournal(db);
  const context = { taskRunId: MANAGED_LIFETIME_RUN, attemptId: nonce };
  expect(
    journal.claimNow(
      nonce,
      MANAGED_LIFETIME_TOOL,
      context,
      managedLifetimeFingerprint({
        ...context,
        id: nonce,
        tool: MANAGED_LIFETIME_TOOL,
        admission: a,
      }),
      a,
    ),
  ).toBe(true);
  db.prepare('UPDATE tool_invocations_v2 SET task_run_id=?,tool=?').run('ordinary-run', 'write');
  expect(journal.inspectPending()[0]?.admission).toBeUndefined();
});
it('rejects a private lifetime whose expected user slice contradicts its service owner', async () => {
  const { validManagedLifetime } = await import('@runnets/domain');
  const corrupt = structuredClone(a);
  const binding = corrupt.binding as Record<string, ServiceJson>;
  const life = binding['managedLifetime'] as Record<string, ServiceJson>;
  const group = life['cgroup'];
  if (typeof group !== 'string') throw Error('fixture group');
  life['cgroup'] = group.replace('user@1000.service', 'user@1001.service');
  expect(
    validManagedLifetime({
      taskRunId: MANAGED_LIFETIME_RUN,
      attemptId: nonce,
      id: nonce,
      tool: MANAGED_LIFETIME_TOOL,
      admission: corrupt,
    }),
  ).toBe(false);
});
