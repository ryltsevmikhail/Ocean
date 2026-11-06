import { afterEach, expect, it } from 'vitest';
import {
  RuntimeOwnerDecisions,
  ServiceTurnTools,
  type ServiceCallConfirmation,
} from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import { createHash } from 'node:crypto';
import { rig } from '../../../../packages/store-sqlite/test-fixtures/service-call-rig.js';
import { RuntimeDecisions } from './decisions.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0)) run();
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('cannot replace a live service waiter or turn an allowed/interrupted row into another permit', async () => {
  const db = openSqliteStore({ path: ':memory:' });
  cleanup.push(() => db.close());
  const runtime = new RuntimeDecisions(db.ownerDecisions, {} as never, () => 5);
  const operation: ServiceCallConfirmation = {
    request: {
      workspaceId: 'w',
      roomId: 'r',
      botId: 'b',
      projectId: null,
      taskId: null,
      connectionId: 'c',
      tool: 't',
      arguments: {},
      grantReference: { grantId: 'g', revision: 1 },
      taskRunId: 'run',
      attemptId: 'at',
      invocationId: 'exact',
    },
    configuration: { kind: 'http', url: 'https://synthetic.example/mcp' },
    definition: {
      name: 't',
      description: 't',
      inputSchema: {},
      outputSchema: null,
      annotations: null,
      definitionDigest: 'a'.repeat(64),
      provenance: {},
    },
    effect: {
      scope: { kind: 'legacy-global-unknown' },
      effectKind: 'mutation',
      grantReference: { grantId: 'g', revision: 1 },
      binding: {},
    },
  };
  let checks = 0;
  const abort = new AbortController();
  const first = runtime.service(operation, abort.signal, async () => {
    checks++;
    return true;
  });
  const card = db.ownerDecisions.list({ workspaceId: 'w', roomId: 'r' }, '', 50)[0]!;
  const preview = db.ownerDecisions.preview(card);
  await expect(
    runtime.service(
      { ...operation, request: { ...operation.request, arguments: { changed: true } } },
      abort.signal,
      async () => true,
    ),
  ).rejects.toThrow();
  expect(db.ownerDecisions.preview(card)).toBe(preview);
  expect(await runtime.owner.resolve(card, card.bindingDigest, 1, 'allow-once')).toMatchObject({
    status: 'allowed',
  });
  expect(await first).toBe('allowed');
  expect(checks).toBe(1);
  await expect(runtime.service(operation, abort.signal, async () => true)).rejects.toThrow();
  const pending = { ...card, decisionId: 'interrupted' };
  db.ownerDecisions.insert(pending, preview!);
  const restarted = new RuntimeOwnerDecisions(db.ownerDecisions, () => 5);
  expect(await restarted.resolve(pending, pending.bindingDigest, 1, 'allow-once')).toMatchObject({
    status: 'interrupted',
  });
  expect(db.ownerDecisions.preview(pending)).toBe(preview);
});
it('binds exact repeats and changed model payloads before a second confirmation or claim', async () => {
  let confirmations = 0,
    sends = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const f = rig(
    async (input) => {
      expect(input.authorizeDispatch()).toBe(true);
      sends++;
      return {
        kind: 'observed',
        code: 'ok',
        invocationId: input.invocationId,
        result: true,
        vendorErrorCode: null,
      };
    },
    2000,
    {
      confirmation: {
        confirm: async () => {
          confirmations++;
          await gate;
          return 'allowed';
        },
      },
    },
  );
  f.owners.revise(f.request.grantReference, { ...f.intent, mode: 'confirm' });
  const tools = new ServiceTurnTools({
    store: f.authority,
    admission: f.service,
    ownerId: 'owner',
    now: () => Date.parse('2026-11-05'),
    restored: false,
    sha256: hash,
    ready: () => true,
    subject: () => f.request,
  });
  const selected = await tools.forTurn(
    { workspaceId: 'ws', roomId: 'room', taskRunId: 'run', bot: { id: 'bot_dev' } } as never,
    new AbortController().signal,
  );
  expect(selected).not.toBeNull();
  const call = { id: 'same', name: selected!.definitions[0]!.name, arguments: '{}' };
  const signal = new AbortController().signal,
    context = { taskRunId: 'run', attemptId: 'at' };
  const first = selected!.execute(call, signal, context),
    repeat = selected!.execute(call, signal, context);
  expect(repeat).toBe(first);
  expect(
    await selected!.execute({ ...call, arguments: '{"changed":true}' }, signal, context),
  ).toMatchObject({ isError: true, output: expect.stringContaining('identity_conflict') });
  expect(confirmations).toBe(1);
  expect(sends).toBe(0);
  release();
  expect((await first).isError).toBe(false);
  expect(sends).toBe(1);
  expect(f.journal.grantCalls('run', 'grant')).toBe(1);
});
