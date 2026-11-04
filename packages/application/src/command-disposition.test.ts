import { describe, expect, it } from 'vitest';
import { TaskRunService, type EventLogPort, type TaskRunServiceDeps } from './index.js';
import { InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';

const command: AnyCommand = {
  type: 'CreateTaskRun',
  commandId: 'cm_disposition',
  taskRunId: taskRunId('tr_disposition'),
  expectedVersion: 0,
  actor: { kind: 'user', id: 'owner' },
  payload: {
    conversationId: conversationId('cv_disposition'),
    workspaceId: workspaceId('ws_disposition'),
    parentTaskRunId: null,
    model: 'original',
    policyId: 'pl_policy',
    budget: unlimitedBudget(),
  },
};
function setup() {
  const ids = new SequentialIdGenerator();
  const log = new InMemoryEventLog(ids);
  const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
  const deps = { log, ids, clock };
  return { ...deps, service: new TaskRunService(deps) };
}

describe('command disposition authority', () => {
  it('reports fresh commit, lookup replay and unchanged legacy receipt bytes', async () => {
    const { service, log } = setup();
    const fresh = await service.executeWithDisposition(command);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw fresh.error;
    expect(fresh.value.disposition).toBe('committed');
    const replay = await service.executeWithDisposition(command);
    expect(replay).toEqual({ ok: true, value: { ...fresh.value, disposition: 'replayed' } });
    const legacy = await service.execute(command);
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw legacy.error;
    expect(JSON.stringify(legacy.value)).toBe(JSON.stringify(fresh.value.receipt));
    expect(await log.load(command.taskRunId)).toHaveLength(1);
    expect(await service.executeWithDisposition({ ...command, expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' },
    });
  });

  it('reports replay when a decision recheck finds a commit during stream load', async () => {
    const { service, log, ids, clock } = setup();
    const raced = new TaskRunService({
      log: {
        commands: log.commands,
        load: async (id) => {
          expect((await service.executeWithDisposition(command)).ok).toBe(true);
          return log.load(id);
        },
        append: (...args) => log.append(...args),
      },
      ids,
      clock,
    });
    expect(await raced.executeWithDisposition(command)).toMatchObject({
      ok: true,
      value: { disposition: 'replayed' },
    });
    expect(await log.load(command.taskRunId)).toHaveLength(1);
  });

  it.each(['no commands', 'legacy atomic port'])(
    'refuses %s before lookup, loading, append or legacy dedup effects',
    async (capability) => {
      const { log, ids, clock } = setup();
      const unexpected = (): never => {
        throw new Error('unexpected I/O');
      };
      const legacy: EventLogPort = { load: unexpected, append: unexpected };
      if (capability === 'legacy atomic port') {
        Object.assign(legacy, { commands: { lookup: unexpected, commit: log.commands.commit } });
      }
      const service = new TaskRunService({
        log: legacy,
        ids,
        clock,
        dedup: { get: unexpected, put: unexpected },
      });
      await expect(service.executeWithDisposition(command)).rejects.toThrow(
        'atomic_commands_required',
      );
    },
  );

  it('preserves legacy non-atomic execution', async () => {
    const { log, ids, clock } = setup();
    const legacy = new TaskRunService({
      log: { load: (...args) => log.load(...args), append: (...args) => log.append(...args) },
      ids,
      clock,
    });
    expect(await legacy.execute(command)).toMatchObject({ ok: true, value: { version: 1 } });
  });

  it('preserves legacy atomic ports for execute', async () => {
    const { log, ids, clock } = setup();
    const legacy = new TaskRunService({
      log: {
        commands: { lookup: log.commands.lookup, commit: log.commands.commit },
        load: (...args) => log.load(...args),
        append: (...args) => log.append(...args),
      },
      ids,
      clock,
    });
    expect(await legacy.execute(command)).toMatchObject({ ok: true, value: { version: 1 } });
  });

  it('snapshots before the first asynchronous callback', async () => {
    const { log, ids, clock } = setup();
    const submitted = { ...command, payload: { ...command.payload } };
    const service = new TaskRunService({
      log: {
        commands: {
          ...log.commands,
          lookup: async (request) => {
            submitted.payload.model = 'mutated';
            return log.commands.lookup(request);
          },
        },
        load: (...args) => log.load(...args),
        append: (...args) => log.append(...args),
      },
      ids,
      clock,
    });
    expect(await service.executeWithDisposition(submitted)).toMatchObject({
      ok: true,
      value: { receipt: { events: [{ payload: { model: 'original' } }] } },
    });
    expect(await service.executeWithDisposition(command)).toMatchObject({
      ok: true,
      value: { disposition: 'replayed' },
    });
    expect((await service.executeWithDisposition(submitted)).ok).toBe(false);
  });

  it('keeps the authoritative disposition when the optional mirror fails', async () => {
    const deps: TaskRunServiceDeps = setup();
    const service = new TaskRunService({
      ...deps,
      dedup: { get: () => Promise.resolve(null), put: () => Promise.reject(Error('mirror')) },
    });
    expect(await service.executeWithDisposition(command)).toMatchObject({
      ok: true,
      value: { disposition: 'committed' },
    });
    expect(await service.executeWithDisposition(command)).toMatchObject({
      ok: true,
      value: { disposition: 'replayed' },
    });
  });
});
