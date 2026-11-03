import { randomUUID } from 'node:crypto';
import {
  TaskRunService,
  type Clock,
  type CommandDedupPort,
  type EventLogPort,
} from '@runnets/application';
import { SequentialIdGenerator, systemClock } from '@runnets/store';
export function runtimeServiceOver(
  log: EventLogPort,
  dedup: CommandDedupPort,
  durable: boolean,
  clock: Clock = systemClock,
): TaskRunService {
  return new TaskRunService({
    log,
    dedup,
    clock,
    ids: durable
      ? {
          eventId: () => `ev_${randomUUID().replaceAll('-', '')}`,
          commandId: () => `cm_${randomUUID().replaceAll('-', '')}`,
        }
      : new SequentialIdGenerator(),
  });
}
