import { call } from './bridge.js';
import type { RoomTasksState } from './room-task-state.js';
// Keep service decision mechanics in their existing owner; bind this task view's
// requests to the exact root/room/profile/instance that opened the card.
export function taskDecisionScope(state: RoomTasksState, request: typeof call = call) {
  const binding = state.binding.value && { ...state.binding.value },
    root = state.selected.value,
    room = state.room.value;
  let closed = false;
  function assert() {
    if (
      closed ||
      !binding ||
      !state.current.value ||
      state.stale.value ||
      root !== state.selected.value ||
      room !== state.room.value ||
      binding.profileId !== state.binding.value?.profileId ||
      binding.instanceId !== state.binding.value.instanceId
    )
      throw Error('decision_context_changed');
  }
  const scoped = (async (command: Parameters<typeof call>[0]) => {
    assert();
    if (
      !['service-decision', 'service-preview', 'service-resolve', 'service-decisions'].includes(
        command.op,
      ) ||
      !('input' in command) ||
      !('roomId' in command.input) ||
      command.input.roomId !== room
    )
      throw Error('decision_context_changed');
    if (!(await state.verify())) throw Error('task_identity_changed');
    assert();
    const result = await request({
      ...command,
      ...(command.op !== 'service-decisions' ? { binding: binding! } : {}),
    });
    assert();
    if (!(await state.verify())) throw Error('task_identity_changed');
    assert();
    return result;
  }) as typeof call;
  return {
    request: scoped,
    close: () => {
      closed = true;
    },
  };
}
