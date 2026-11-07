import {
  LOCAL_ROOM_TASKS,
  LOCAL_ROOM_TASK_LIST,
  LOCAL_ADDRESSED_HISTORY,
} from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { taskReplyMatches, type TaskCommand } from '../room-task-protocol.js';
export async function dispatchRoomTask(client: LocalRuntimeClient, c: TaskCommand) {
  const { profileId, instanceId, capabilities } = client.identity;
  const supported = [LOCAL_ROOM_TASKS, LOCAL_ROOM_TASK_LIST, LOCAL_ADDRESSED_HISTORY].every((x) =>
    capabilities.includes(x),
  );
  if (c.op === 'task-support') return { profileId, instanceId, supported };
  if (!supported) throw Error('task_runtime_upgrade_required');
  if (c.binding.profileId !== profileId || c.binding.instanceId !== instanceId)
    throw Error('task_identity_changed');
  let reply: unknown;
  switch (c.op) {
    case 'task-list':
      reply = await client.roomTaskList(c.input);
      break;
    case 'task-start':
      reply = await client.roomTaskStart(c.input);
      break;
    case 'task-get':
      reply = await client.roomTaskGet(c.input);
      break;
    case 'task-observe':
      reply = await client.roomTaskObserve({ ...c.input, waitMs: 1000 });
      break;
    case 'task-stop':
      reply = await client.roomTaskStop(c.input);
      break;
  }
  if (!taskReplyMatches(c, reply)) throw Error('invalid_frame');
  return reply;
}
