import { createHash } from 'node:crypto';
import { serviceConnection } from '../../../test-fixtures/service-authority.js';
import {
  MANAGED_LIFETIME_RUN,
  MANAGED_LIFETIME_TOOL,
  managedEnrollment,
  managedLifetimeFingerprint,
  type ServiceConnection,
  type ToolEffectAdmission,
} from '@runnets/domain';
export function managedLifetimeFixture(
  id = 'a',
  root = '/a',
  nonce = '11111111-1111-1111-1111-111111111111',
) {
  const connection: ServiceConnection = {
    ...serviceConnection,
    credentialReference: null,
    id,
    configuration: {
      kind: 'stdio',
      executable: '/server.mjs',
      sha256: 'a'.repeat(64),
      args: [],
      workspaceRoot: root,
    },
  };
  const enrollment = managedEnrollment(connection);
  const unit = 'ocean-mcp-' + 'a'.repeat(32) + '-' + nonce + '.service';
  const admission: ToolEffectAdmission = {
    scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: id }] },
    effectKind: 'mutation',
    grantReference: null,
    binding: {
      connectionId: id,
      managedEnrollment: enrollment,
      managedWorkspace: {
        version: 1,
        root,
        boot: '11111111-1111-1111-1111-111111111111',
        mountNamespace: 'mnt:[1]',
        mountId: '1',
        dev: '1',
        ino: root === '/a' ? '1' : '2',
        anchor:
          'linux-btrfs-v1:' +
          'a'.repeat(32) +
          ':' +
          'b'.repeat(32) +
          ':1:1:' +
          (root === '/a' ? '01' : '02'),
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
  const claim = {
    taskRunId: MANAGED_LIFETIME_RUN,
    attemptId: nonce,
    id: nonce,
    tool: MANAGED_LIFETIME_TOOL,
    admission,
  };
  const fingerprint = createHash('sha256').update(managedLifetimeFingerprint(claim)).digest('hex');
  return {
    connection,
    admission,
    claim,
    record: { ...claim, outcome: 'started' as const, fingerprint },
  };
}
