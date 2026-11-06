import { DatabaseSync } from 'node:sqlite';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  OwnerScopeService,
  ServiceCallAdmissionService,
  publishServiceCatalogRefresh,
  currentServiceCatalog,
  type ServiceCallTransportPort,
} from '@runnets/application';
import {
  canonicalJson,
  type ServiceConnection,
  type ServiceCatalogSnapshot,
  type ServiceJson,
} from '@runnets/domain';
export const subject = {
  workspaceId: 'ws',
  roomId: 'room',
  botId: 'bot',
  projectId: null,
  taskId: null,
};
export function connection(
  configuration: ServiceConnection['configuration'],
  ref: string | null = null,
): ServiceConnection {
  const at = new Date().toISOString();
  return {
    id: 'connection',
    name: 'qualification',
    configuration,
    configRevision: 1,
    credentialRevision: 1,
    trustRevision: 1,
    credentialReference: ref,
    trust: {
      ownerId: 'owner',
      identity: { status: 'unverified', label: null },
      metadataPermission: 'allow',
      resourceEnforcement: [],
    },
    state: 'active',
    currentCatalogId: null,
    createdAt: at,
    updatedAt: at,
  };
}
/** An explicitly owned test DB. No token, request body or server response is persisted. */
export function admission(
  path: string,
  c: ServiceConnection,
  transport: ServiceCallTransportPort,
  deadlineMs = 2000,
) {
  const store = openSqliteStore({ path });
  const setup = new DatabaseSync(path);
  try {
    setup.exec(`INSERT INTO ocean_workspace VALUES(1,'ws','/project');
      INSERT INTO ocean_bots VALUES('bot','ws','dev','Dev','Role','test','test',1);
      INSERT INTO ocean_rooms VALUES('room','ws','group',NULL,'Team');
      INSERT INTO ocean_members VALUES('ws','room','bot');`);
    setup
      .prepare("INSERT INTO ocean_chat_turns VALUES('turn','ws','room','run','dispatching',?,NULL)")
      .run(
        JSON.stringify({
          id: 'turn',
          status: 'dispatching',
          taskRunId: 'run',
          workspaceId: 'ws',
          roomId: 'room',
          bot: { id: 'bot', workspaceId: 'ws' },
        }),
      );
  } finally {
    setup.close();
  }
  const authority = store.serviceAuthority;
  authority.atomic((tx) => {
    if (!tx.putConnection(c, null)) throw Error('connection conflict');
  });
  const owner = new OwnerScopeService(authority, 'owner', Date.now);
  const service = new ServiceCallAdmissionService({
    store: authority,
    transport,
    now: Date.now,
    restored: false,
    deadlineMs,
  });
  return {
    store,
    authority,
    owner,
    metadata: (target: ServiceConnection) =>
      authority.atomic((tx) => {
        const row = tx.connection(target.id);
        return (
          row?.state === 'active' &&
          row.trust.metadataPermission === 'allow' &&
          row.configRevision === target.configRevision &&
          row.trustRevision === target.trustRevision &&
          row.credentialRevision === target.credentialRevision
        );
      }),
    publish: (s: ServiceCatalogSnapshot) =>
      authority.atomic((tx) => publishServiceCatalogRefresh(tx, s)),
    current: (s: ServiceCatalogSnapshot) =>
      authority.atomic((tx) => {
        const row = tx.connection(c.id);
        if (!row || row.trust.metadataPermission !== 'allow') return false;
        const current = currentServiceCatalog(tx, row);
        return !!current && current.id === s.id && canonicalJson(current) === canonicalJson(s);
      }),
    grant: (names: string[]) =>
      owner.issue({
        id: 'grant',
        subject,
        permissions: [
          {
            kind: 'service',
            connectionId: c.id,
            trustRevision: c.trustRevision,
            tools: { kind: 'exact', names },
            resources: [{ kind: 'connection', connectionId: c.id }],
          },
        ],
        limits: { maxCalls: 32, maxEffectBytes: 65536, expiresAt: null },
      }),
    call: (catalogId: string, tool: string, args: ServiceJson, id: string, signal?: AbortSignal) =>
      service.call(
        {
          ...subject,
          connectionId: c.id,
          catalogId,
          tool,
          arguments: args,
          invocationId: id,
          grantReference: { grantId: 'grant', revision: 1 },
          taskRunId: 'run',
          attemptId: 'at',
        },
        signal,
      ),
  };
}
