import { expect, it } from 'vitest';
import { OwnerScopeService, ServiceCallAdmissionService } from '@runnets/application';
import {
  ownerGrant,
  serviceConnection,
  serviceCatalog,
  authorityAt,
} from '../../../test-fixtures/service-authority.js';
import { claimFixture } from '../test-fixtures/finalization-claims.js';
import { codingProjectId } from './service-run-scope.js';
it('intersects a coding task grant with the actual live turn, exact leased project identity and task status', async () => {
  const f = claimFixture(),
    now = () => Date.parse(authorityAt);
  try {
    const t = f.task,
      subject = {
        workspaceId: t.workspaceId,
        roomId: t.ownerRoomId,
        botId: t.devBotId,
        taskId: t.id,
        projectId: codingProjectId(t.projectRoot),
      };
    const turn = {
      id: 'turn',
      status: 'dispatching',
      taskRunId: 'tr',
      workspaceId: t.workspaceId,
      roomId: t.ownerRoomId,
      bot: { id: t.devBotId, workspaceId: t.workspaceId },
      codingTaskId: t.id,
    };
    f.db
      .prepare("INSERT INTO ocean_chat_turns VALUES('turn','ws','room','tr','dispatching',?,NULL)")
      .run(JSON.stringify(turn));
    f.store.serviceAuthority.atomic((tx) => {
      expect(tx.putConnection(serviceConnection, null)).toBe(true);
      expect(tx.putCatalog(serviceCatalog)).toBe(true);
      expect(tx.publishCatalog('third', serviceConnection, 'catalog')).toBe(true);
    });
    const owners = new OwnerScopeService(f.store.serviceAuthority, 'owner', now);
    const g = owners.issue({
      id: 'grant',
      subject,
      permissions: ownerGrant.permissions,
      limits: ownerGrant.limits,
    });
    const service = new ServiceCallAdmissionService({
      store: f.store.serviceAuthority,
      restored: false,
      now,
      transport: {
        invoke: async (i) => {
          if (!i.authorizeDispatch()) throw Error('no dispatch');
          return {
            kind: 'observed',
            invocationId: i.invocationId,
            code: 'ok',
            result: true,
            vendorErrorCode: null,
          };
        },
      },
    });
    const r = {
      ...subject,
      tool: 'notes.search',
      arguments: {},
      connectionId: 'third',
      catalogId: 'catalog',
      invocationId: 'i',
      taskRunId: 'tr',
      attemptId: 'a',
      grantReference: { grantId: g.id, revision: g.revision },
    };
    for (const change of [
      { projectId: null },
      { projectId: codingProjectId('/foreign') },
      { taskId: null },
      { taskId: 'foreign' },
      { taskRunId: 'foreign' },
    ])
      expect((await service.call({ ...r, ...change })).outcome).toBeNull();
    expect((await service.call(r)).outcome?.kind).toBe('observed');
    f.store.coding.atomic((tx) => tx.putTask({ ...t, status: 'cancelled' }));
    expect((await service.call({ ...r, invocationId: 'new' })).code).toBe('authority_denied');
  } finally {
    f.close();
  }
});
