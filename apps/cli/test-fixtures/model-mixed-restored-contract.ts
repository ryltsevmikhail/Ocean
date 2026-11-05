import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  ChatReviewService,
  DirectChatService,
  ModelConnectionService,
  ProviderActivationService,
  TaskRunService,
} from '@runnets/application';
import type { LocalBoundBot } from '@runnets/contracts';
import { mixedPorts } from './model-mixed-ports.ts';
import { descriptors } from './model-mixed-setup.ts';
// eslint-disable-next-line no-restricted-imports -- Source contract only; executes built factory.
import type * as Factory from '../src/local-runtime/provider-activation-factory.js';
const { createProviderActivationFactory }: typeof Factory = await import(
  String('../dist/local-runtime/provider-activation-factory.js')
);
/** Trusted lower-layer composition after the maintenance owner has closed. No ready epoch is forged. */
export async function restoredConnectionContract(
  profile: string,
  bots: LocalBoundBot[],
  roomId: string,
) {
  const store = openSqliteStore({ path: profile + '/runtime.sqlite' });
  try {
    const http = mixedPorts(profile),
      nextId = () => randomUUID().replaceAll('-', '');
    const clock = { now: () => new Date() };
    const forbidden = () => {
      throw Error('restored sibling secret effect');
    };
    const secrets = { read: forbidden, write: forbidden, replace: forbidden, remove: forbidden };
    const factory = createProviderActivationFactory({ env: {}, httpClient: http.http });
    const service = new ModelConnectionService({
      store: store.modelConnections,
      restored: true,
      secrets,
      factory,
      clock,
      nextId,
      sha256: (v) => createHash('sha256').update(v).digest('hex'),
    });
    const resolver = new ProviderActivationService({
      connections: store.modelConnections,
      restored: true,
      disabled: false,
      secrets,
      factory,
    });
    const resolve = (index: number) =>
      resolver.resolve(
        { bot: bots[index]!.bot, binding: bots[index]!.binding! },
        clock.now().toISOString(),
      );
    assert.deepEqual(
      bots.map((_, i) => resolve(i).ok),
      [false, false, false],
    );
    assert.deepEqual(http.snapshot(), { origins: {}, requests: [] });
    service.set({
      ...descriptors[0]!,
      expectedRevision: store.modelConnections.read('local')!.revision,
      requestId: 'explicit-local-contract',
    });
    assert.equal((await service.check('local')).check.outcome, 'ok');
    assert.deepEqual(
      bots.map((_, i) => resolve(i).ok),
      [true, false, false],
    );
    const tasks = new TaskRunService({
      log: store.log,
      clock,
      ids: { eventId: () => 'ev_' + nextId(), commandId: () => 'cm_' + nextId() },
    });
    const deps = { tasks, store: store.conversations, clock, nextId };
    const reviews = new ChatReviewService({ ...deps, journal: store.tools });
    const chat = new DirectChatService({ ...deps, reviews });
    const result = await chat.send({
      workspaceId: 'ws_ocean',
      roomId,
      requestId: 'explicit-local-contract-turn',
      text: 'trusted lower-layer reconnect',
      resolver,
      signal: new AbortController().signal,
      emit: () => {},
    });
    assert.equal(result.ok && result.value.status, 'completed');
    const configured = descriptors.map(
      (d) => store.modelConnections.read(d.connectionId)!.configuredAfterRestore,
    );
    assert.deepEqual(configured, [true, false, false]);
    assert.equal(http.snapshot().requests.length, 1);
    return {
      configured,
      ...http.snapshot(),
      qualification:
        'trusted public application contract only; product owner rebind remains unqualified',
    };
  } finally {
    store.close();
  }
}
