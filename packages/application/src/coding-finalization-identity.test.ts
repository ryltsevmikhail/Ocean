import { expect, it } from 'vitest';
import type { CodingFinalizationRecord, CodingFinalizationReleaseReceipt } from '@runnets/domain';
import { recoverCodingFinalizations } from './coding-finalization-recovery.js';
import type { ProjectLeaseReleasePort } from './coding-finalization-ports.js';
import { fixture } from '../test-fixtures/coding-finalization-fakes.js';
async function interrupted() {
  const f = fixture();
  await f.service.preview(f.selection, new AbortController().signal);
  const old = f.store.records.get(f.selection.requestId)!;
  const record: CodingFinalizationRecord = {
    ...old,
    revision: old.revision + 1,
    state: 'finalizing',
    release: { state: 'pending', outcome: null, receipt: null, detail: null },
  };
  f.store.atomic((tx) => tx.disable(record));
  await f.service.close();
  const b = record.preview.binding;
  const receipt: CodingFinalizationReleaseReceipt = {
    version: 1,
    operationId: record.requestId,
    bindingDigest: record.bindingDigest,
    taskId: b.task.id,
    workspaceId: b.task.workspaceId,
    ownerId: b.owner.profileOwnerId,
    projectRoot: b.project.root,
    tokenHash: b.lease.tokenHash,
    holderHash: b.lease.holderHash,
    releasedAt: '2026-11-03T00:00:00.000Z',
    registry: b.lease.registry,
  };
  return { ...f, record, receipt };
}
it.each(['legacy', 'scoped'] as const)(
  'recovers an exact %s receipt by reads only across two openings',
  async (mode) => {
    const f = await interrupted();
    const lookups: string[] = [];
    const id =
      mode === 'legacy' ? f.record.requestId : 'ocean-finalize-v2-' + f.record.bindingDigest;
    const receipt = { ...f.receipt, operationId: id };
    const leases: ProjectLeaseReleasePort = {
      acquire: () => {
        throw Error('no effects');
      },
      owns: () => true,
      release: () => {
        throw Error('no effects');
      },
      identity: () => f.receipt.registry,
      releaseExact: () => {
        throw Error('never retry');
      },
      releaseReceipt: (operationId) => {
        lookups.push(operationId);
        return operationId === id ? receipt : null;
      },
    };
    const before = JSON.stringify(f.record.preview);
    recoverCodingFinalizations(f.store, leases);
    expect(f.store.records.get(f.record.requestId)).toMatchObject({
      state: 'finalized',
      release: { receipt },
    });
    const count = lookups.length;
    recoverCodingFinalizations(f.store, leases);
    expect(lookups).toHaveLength(count);
    expect(JSON.stringify(f.store.records.get(f.record.requestId)!.preview)).toBe(before);
    expect(lookups[0]).toBe('ocean-finalize-v2-' + f.record.bindingDigest);
  },
);
it.each([
  'operationId',
  'bindingDigest',
  'taskId',
  'workspaceId',
  'ownerId',
  'projectRoot',
  'tokenHash',
  'holderHash',
  'registry',
  'registrySchema',
] as const)('does not promote a legacy receipt with mismatched %s', async (field) => {
  const f = await interrupted();
  const wrong =
    field === 'registrySchema'
      ? { ...f.receipt, registry: { ...f.receipt.registry, schema: 'wrong' } }
      : {
          ...f.receipt,
          [field]:
            field === 'registry' ? { ...f.receipt.registry, path: '/other/registry' } : 'wrong',
        };
  const leases: ProjectLeaseReleasePort = {
    acquire: () => {
      throw Error('no effects');
    },
    owns: () => true,
    release: () => false,
    identity: () => f.receipt.registry,
    releaseExact: () => {
      throw Error('never retry');
    },
    releaseReceipt: (id) => (id === f.record.requestId ? wrong : null),
  };
  recoverCodingFinalizations(f.store, leases);
  expect(f.store.records.get(f.record.requestId)?.state).toBe('uncertain');
  const before = structuredClone(f.store.records.get(f.record.requestId));
  recoverCodingFinalizations(f.store, leases);
  expect(f.store.records.get(f.record.requestId)).toEqual(before);
});
it.each(['wrong', 'thrown'] as const)(
  'does not bypass a %s scoped receipt with a valid legacy receipt',
  async (mode) => {
    const f = await interrupted();
    const lookups: string[] = [];
    const leases: ProjectLeaseReleasePort = {
      acquire: () => {
        throw Error('no effects');
      },
      owns: () => true,
      release: () => false,
      identity: () => f.receipt.registry,
      releaseExact: () => {
        throw Error('never retry');
      },
      releaseReceipt: (id) => {
        lookups.push(id);
        if (id === f.record.requestId) return f.receipt;
        if (mode === 'thrown') throw Error('registry_corrupt');
        return { ...f.receipt, operationId: id, tokenHash: '0'.repeat(64) };
      },
    };
    recoverCodingFinalizations(f.store, leases);
    expect(f.store.records.get(f.record.requestId)?.state).toBe('uncertain');
    expect(lookups).toEqual(['ocean-finalize-v2-' + f.record.bindingDigest]);
  },
);
