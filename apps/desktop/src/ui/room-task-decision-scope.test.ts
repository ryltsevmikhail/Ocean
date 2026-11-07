import { expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { taskDecisionScope } from './room-task-decision-scope.js';
import type { RoomTasksState } from './room-task-state.js';
const binding = { profileId: 'a'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111' };
function setup() {
  return {
    binding: ref({ ...binding }),
    selected: ref('root'),
    room: ref('r'),
    current: ref(true),
    stale: ref(false),
    verify: async () => true,
  } as unknown as RoomTasksState;
}
const command = {
  op: 'service-resolve' as const,
  input: {
    workspaceId: 'ws_ocean',
    roomId: 'r',
    runId: 'run',
    decisionId: 'd',
    expectedVersion: 3,
    bindingDigest: 'b'.repeat(64),
    choice: 'allow-once' as const,
  },
};
it('preserves exact service vote and native identity binding and ignores a held response after selection or profile changes', async () => {
  let release!: (v: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise((yes) => {
        release = yes;
      }),
  );
  const state = setup(),
    scope = taskDecisionScope(state, request as never);
  const vote = scope.request(command);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(request.mock.calls[0]).toEqual([{ ...command, binding }]);
  state.selected.value = 'other';
  release({ status: 'allowed' });
  await expect(vote).rejects.toThrow('decision_context_changed');
  expect(request).toHaveBeenCalledOnce();
});
it('refuses dispatch after a held identity check or closed card, without a silent fresh vote', async () => {
  let release!: (v: boolean) => void;
  const state = setup();
  state.verify = () =>
    new Promise((yes) => {
      release = yes;
    });
  const request = vi.fn(),
    scope = taskDecisionScope(state, request as never);
  const vote = scope.request(command);
  state.binding.value = { ...binding, profileId: 'c'.repeat(64) };
  release(true);
  await expect(vote).rejects.toThrow('decision_context_changed');
  expect(request).not.toHaveBeenCalled();
  scope.close();
  await expect(scope.request(command)).rejects.toThrow('decision_context_changed');
});
