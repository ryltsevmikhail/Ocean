/* eslint-disable no-restricted-imports -- Real SQLite service admission fixture. */
import { expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import {
  OwnerScopeService,
  ServiceCallAdmissionService,
  type ServiceCallTransportPort,
  type ServiceCallAdmissionOptions,
} from '@runnets/application';
import {
  ownerGrant,
  serviceCatalog,
  serviceConnection,
  authorityAt,
} from '../../../test-fixtures/service-authority.js';
import { store } from './plugin-operation-rig.js';
import { SqliteServiceAuthority } from '../src/service-authority-storage.js';
import { SqliteToolJournal } from '../src/tool-journal.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
export function rig(
  invoke: ServiceCallTransportPort['invoke'],
  deadlineMs = 2000,
  options: Partial<
    Pick<
      ServiceCallAdmissionOptions,
      'classify' | 'credentialContinuous' | 'confirmation' | 'prepareResources'
    >
  > = {},
  file = false,
) {
  const dir = file ? mkdtempSync(join(tmpdir(), 'ocean-call-')) : null;
  if (dir) dirs.push(dir);
  const path = dir ? join(dir, 'database') : ':memory:';
  const db = store(path);
  db.prepare(
    "INSERT INTO ocean_chat_turns VALUES('turn','ws','room','run','dispatching',?,NULL)",
  ).run(
    JSON.stringify({
      id: 'turn',
      status: 'dispatching',
      taskRunId: 'run',
      workspaceId: 'ws',
      roomId: 'room',
      bot: { id: 'bot_dev', workspaceId: 'ws' },
    }),
  );
  const authority = new SqliteServiceAuthority(db);
  authority.atomic((tx) => {
    expect(tx.putConnection(serviceConnection, null)).toBe(true);
    expect(tx.putCatalog(serviceCatalog)).toBe(true);
    expect(tx.publishCatalog('third', serviceConnection, 'catalog')).toBe(true);
  });
  const owners = new OwnerScopeService(authority, 'owner', () => Date.parse(authorityAt));
  const subject = { ...ownerGrant.subject, botId: 'bot_dev' };
  const intent = {
    id: 'grant',
    subject,
    permissions: ownerGrant.permissions,
    limits: ownerGrant.limits,
  };
  const issued = owners.issue(intent);
  const transport: ServiceCallTransportPort = { invoke };
  const service = new ServiceCallAdmissionService({
    restored: false,
    store: authority,
    transport,
    now: () => Date.parse(authorityAt),
    deadlineMs,
    ...options,
  });
  const request = {
    ...subject,
    connectionId: 'third',
    catalogId: 'catalog',
    tool: 'notes.search',
    arguments: {},
    grantReference: { grantId: 'grant', revision: 1 },
    invocationId: 'i',
    taskRunId: 'run',
    attemptId: 'at',
  };
  return {
    db,
    path,
    authority,
    owners,
    issued,
    service,
    transport,
    request,
    intent,
    journal: new SqliteToolJournal(db),
  };
}
