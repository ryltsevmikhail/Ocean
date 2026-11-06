import { expect, it } from 'vitest';
import { effectResourcesConflict, type ToolEffectAdmission } from './effect-resource-conflicts.js';
const managed = (root: string, connectionId = 'a'): ToolEffectAdmission => ({
  scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId }] },
  effectKind: 'mutation',
  grantReference: null,
  binding: {
    connectionId,
    managedWorkspace: {
      version: 1,
      root,
      boot: '11111111-1111-1111-1111-111111111111',
      mountNamespace: 'mnt:[1]',
      mountId: '12',
      dev: '3',
      ino: root === '/a' ? '5' : '6',
      anchor:
        'linux-btrfs-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1:1:' +
        (root === '/a' ? '01' : '02'),
    },
  },
});
it('requires fresh exact admission pair evidence to partition managed sibling workspaces', () => {
  const a = managed('/a'),
    b = managed('/b', 'b');
  expect(effectResourcesConflict(a, b)).toBe(true);
  expect(
    effectResourcesConflict(a, b, {
      existing: a,
      incoming: b,
      existingCoordinate: '/a',
      incomingCoordinate: '/b',
    }),
  ).toBe(false);
});
it('keeps managed ancestry, mismatched proofs and mixed coding scope conservative', () => {
  const a = managed('/a'),
    b = managed('/a/sub', 'b');
  const proof = {
    existing: a,
    incoming: b,
    existingCoordinate: '/a',
    incomingCoordinate: '/a/sub',
  };
  expect(effectResourcesConflict(a, b, proof)).toBe(true);
  expect(effectResourcesConflict(a, managed('/c'), proof)).toBe(true);
  expect(effectResourcesConflict(undefined, b, proof)).toBe(true);
});
it('bounds canonical managed roots by UTF-8 bytes rather than character count', async () => {
  const { managedCanonicalRoot } = await import('./managed-workspace.js');
  expect(managedCanonicalRoot('/' + 'é'.repeat(2048))).toBe(false);
});
