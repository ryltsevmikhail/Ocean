import type { CodingTask } from './coding-task.js';
import type { Changeset } from './changeset.js';
import { codingReviewCurrent, type CodingReviewVerdict } from './coding-review.js';
import { codingTestPassed, type CodingTestEvidence } from './coding-test-evidence.js';

/** Advisory approval becomes application-eligible only with all current preset evidence. */
export function codingApplicationVerified(
  task: CodingTask,
  changeset: Changeset,
  review: CodingReviewVerdict,
  evidence: readonly CodingTestEvidence[],
): boolean {
  if (
    review.verdict !== 'approve' ||
    review.reviewerBotId !== task.reviewBotId ||
    review.reviewRoomId !== task.reviewRoomId ||
    changeset.taskId !== task.id ||
    changeset.baseCommit !== task.baseCommit ||
    task.policy.testPresets.length === 0 ||
    !codingReviewCurrent(
      review.binding,
      changeset,
      evidence.map((test) => test.hash),
    )
  )
    return false;
  return task.policy.testPresets.every((preset) => {
    const test = evidence.findLast((test) => test.presetId === preset.id);
    return (
      test !== undefined &&
      test.binding.taskId === task.id &&
      test.binding.workspaceId === task.workspaceId &&
      test.binding.projectRoot === task.projectRoot &&
      test.binding.worktreeRoot === task.worktreeRoot &&
      test.binding.roomId === task.ownerRoomId &&
      test.binding.botId === task.devBotId &&
      test.binding.policyVersion === task.policyVersion &&
      test.afterTreeHash === changeset.afterTreeHash &&
      codingTestPassed(test)
    );
  });
}
