import { roomTaskState } from './room-task-host.js';
import type { RoomTaskPersistenceDeps } from './room-task-persistence.js';
import type { GrantedPluginTools } from './plugin-turn-tools.js';
import { persistRoomTaskSend } from './room-task-send.js';
import { committedRoomDelegate } from './room-slice-handoff.js';
export function roomTools(d: RoomTaskPersistenceDeps, turnId: string): GrantedPluginTools {
  return {
    cleanupConfirmed: true,
    callDigest: d.sha256,
    definitions: [
      {
        name: 'room_state',
        description: 'Read minimal state for this task or a verified ancestor or descendant.',
        parameters: {
          type: 'object',
          properties: { taskId: { type: 'string' } },
          required: ['taskId'],
          additionalProperties: false,
        },
      },
      {
        name: 'room_send',
        description: 'Send a message to a new constrained child without waiting.',
        parameters: {
          type: 'object',
          properties: { toBotId: { type: 'string' }, text: { type: 'string' } },
          required: ['toBotId', 'text'],
          additionalProperties: false,
        },
      },
      {
        name: 'room_delegate',
        description: 'Delegate local conversation work and yield this slice.',
        parameters: {
          type: 'object',
          properties: { toBotId: { type: 'string' }, text: { type: 'string' } },
          required: ['toBotId', 'text'],
          additionalProperties: false,
        },
      },
    ],
    execute(call, _signal, context) {
      if (!context || !['room_delegate', 'room_send', 'room_state'].includes(call.name))
        return Promise.resolve({ isError: true, output: 'tool unavailable' });
      let request: unknown;
      try {
        request = JSON.parse(call.arguments);
      } catch {
        return Promise.resolve({ isError: true, output: 'invalid arguments' });
      }
      if (call.name === 'room_state') {
        if (
          !request ||
          typeof request !== 'object' ||
          Object.keys(request).join() !== 'taskId' ||
          !('taskId' in request) ||
          typeof request.taskId !== 'string'
        )
          return Promise.resolve({ isError: true, output: 'invalid arguments' });
        try {
          const result = roomTaskState(d, { turnId, ...context, callId: call.id }, request.taskId);
          if ('error' in result) return Promise.resolve({ isError: true, output: result.error });
          if (result.fresh) d.onCommitted?.();
          return Promise.resolve({ isError: false, output: JSON.stringify(result.reply) });
        } catch (error) {
          return Promise.resolve({
            isError: true,
            output: error instanceof Error ? error.message : 'state unavailable',
          });
        }
      }
      if (
        !request ||
        typeof request !== 'object' ||
        Object.keys(request).sort().join() !== 'text,toBotId'
      )
        return Promise.resolve({ isError: true, output: 'invalid arguments' });
      const sent = persistRoomTaskSend(
        d,
        { turnId, ...context, callId: call.id },
        { kind: call.name === 'room_delegate' ? 'delegate' : 'message', ...request },
        true,
      );
      if (!sent.ok) return Promise.resolve({ isError: true, output: sent.error.code });
      if (sent.value.fresh) d.onCommitted?.();
      if (call.name === 'room_send')
        return Promise.resolve({ isError: false, output: JSON.stringify(sent.value.receipt) });
      if (!sent.value.proof)
        return Promise.resolve({
          isError: true,
          uncertain: true,
          output: 'historical receipt has no handoff proof',
        });
      return Promise.resolve(committedRoomDelegate(sent.value.proof));
    },
  };
}
