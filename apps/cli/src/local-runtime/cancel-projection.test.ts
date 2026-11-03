import { randomUUID, randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CodingApprovalService,
  ConversationService,
  DirectChatService,
  RoomRuntimeRuns,
  TaskRunService,
} from '@runnets/application';
import { LOCAL_ROOM_METHODS } from '@runnets/contracts';
import {
  connectLocalRuntime,
  localRuntimePaths,
  prepareLocalRuntimePaths,
} from '@runnets/tools-node';
import { EndpointLayout, profileKey } from './endpoint-files.js';
import { listenLocalRuntime } from './server.js';
import { openSqliteStore } from '@runnets/store-sqlite';
import { RuntimeTurns } from './turns.js';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const finish of cleanup.splice(0).reverse()) await finish();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(['fresh', 'retry', 'changed binding'])(
  'classifies %s cancellation even when 201 pending decisions exceed the observation projection',
  async (mode) => {
    const profile = mkdtempSync(join(tmpdir(), 'ocean-cancel-limit-'));
    cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
    vi.stubEnv('XDG_RUNTIME_DIR', profile);
    const paths = localRuntimePaths(profile);
    prepareLocalRuntimePaths(paths);
    const dbPath = join(profile, 'runtime.sqlite');
    writeFileSync(dbPath, '', { mode: 0o600, flag: 'wx' });
    const store = openSqliteStore({ path: dbPath });
    const layout = new EndpointLayout(paths, profileKey(paths));
    cleanup.push(() => layout.close());
    cleanup.push(() => store.close());
    const deps = {
      store: store.conversations,
      clock: { now: () => new Date() },
      nextId: () => randomUUID().replaceAll('-', ''),
    };
    const tasks = new TaskRunService({
      log: store.log,
      clock: deps.clock,
      ids: { eventId: randomUUID, commandId: randomUUID },
    });
    const chat = new DirectChatService({
      ...deps,
      tasks,
      codingTools: {
        async forTurn() {
          return {
            definitions: [],
            execute: async () => {
              throw Error('unexpected tool execution');
            },
          };
        },
      },
    });
    const approvals = new CodingApprovalService({
      store: store.codingApprovals,
      now: Date.now,
      admit: () => true,
      restored: false,
    });
    const scope = rooms(new ConversationService(deps));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let dispatches = 0,
      aborts = 0;
    const provider = gatedProvider(
      () => gate,
      (s) => {
        dispatches++;
        s.addEventListener('abort', () => {
          aborts++;
        });
      },
    );
    const identity = {
      protocol: 1 as const,
      profileId: paths.profileId,
      instanceId: randomUUID(),
      capabilities: ['status', 'stop', 'turns.submit', 'runs.get', ...LOCAL_ROOM_METHODS],
    };
    const host = new RuntimeTurns(
      chat,
      provider,
      new RoomRuntimeRuns(store.openRoomReads(Date.now), tasks),
      identity.instanceId,
    );
    cleanup.push(async () => {
      release();
      await host.drain();
      host.closeObservers();
    });
    const descriptor = {
      protocol: identity.protocol,
      profileId: paths.profileId,
      instanceId: identity.instanceId,
      endpoint: paths.endpoint,
      capability: randomBytes(32).toString('hex'),
    };
    const transport = await listenLocalRuntime(
      {
        identity,
        descriptor,
        dispatch: host.dispatch.bind(host),
        status: () => ({ ...identity, state: 'ready' }),
        stop: async () => {
          throw Error('unexpected runtime stop');
        },
      },
      layout,
    );
    cleanup.push(() => closeSync(transport.socketFd));
    cleanup.push(() => new Promise<void>((r) => transport.server.close(() => r())));
    writeFileSync(paths.descriptor, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    transport.activate();
    const client = await connectLocalRuntime({ profile });
    cleanup.push(() => client.close());
    const { workspaceId, roomId, requestId, text } = scope;
    const taskId = 'test-task';
    const admitted = await client.submit({ workspaceId, roomId, requestId, text, taskId });
    if (!admitted.runId) throw Error('expected addressed admission');
    const run = { workspaceId, roomId, runId: admitted.runId };
    await vi.waitFor(() => expect(dispatches).toBe(1));
    const initial = await client.getRun(run);
    if (!initial) throw Error('expected run snapshot');
    const { performerId, version } = initial;
    const cancel = { ...run, requestId: 'cancel', expectedVersion: version };
    const ack = { ...cancel, version: version + 1, status: 'requested' };
    if (mode !== 'fresh') expect(await client.cancelRun(cancel)).toEqual(ack);
    const binding = {
      ...run,
      taskId,
      botId: performerId,
      projectRoot: '/fixture',
      worktreeRoot: '/fixture/work',
      attemptId: 'a',
      invocationId: 'inv',
      operation: 'write' as const,
      operationHash: 'h',
      sourceTreeHash: 's',
      policyVersion: 1,
      limitsHash: 'l',
      toolchainHash: 't',
    };
    for (let i = 0; i < 201; i++) {
      expect(approvals.request('decision-' + i, binding, 'synthetic preview').ok).toBe(true);
      const createdAt = Date.now();
      store.ownerDecisions.insert(
        {
          ...run,
          decisionId: 'decision-' + i,
          kind: 'write',
          createdAt,
          expiresAt: createdAt + 300000,
          status: 'pending',
          version: 1,
          previewLength: 5,
          bindingDigest: 'a'.repeat(64),
        },
        'exact',
      );
    }
    await expect(client.getRun(run)).rejects.toThrow('query_limit');
    if (mode === 'changed binding') {
      for (const changed of [
        { runId: 'missing' },
        { runId: 'tr_missing' },
        { roomId: scope.groupId },
        { workspaceId: 'other' },
        { expectedVersion: version + 1 },
      ]) {
        await expect(client.cancelRun({ ...cancel, ...changed })).rejects.toThrow(
          'request_conflict',
        );
      }
    } else {
      if (mode === 'fresh') {
        await expect(client.cancelRun({ ...cancel, roomId: scope.groupId })).rejects.toThrow(
          'unknown_run',
        );
        await expect(client.cancelRun({ ...cancel, runId: 'missing' })).rejects.toThrow(
          'unknown_run',
        );
        await expect(client.cancelRun({ ...cancel, expectedVersion: 0 })).rejects.toThrow(
          'version_conflict',
        );
        expect(aborts).toBe(0);
      }
      expect(await client.cancelRun(cancel)).toEqual(ack);
      expect(await client.cancelRun(cancel)).toEqual(ack);
    }
    expect(aborts).toBe(1);
    expect(dispatches).toBe(1);
  },
);
