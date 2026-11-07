import { createHash } from 'node:crypto';
import {
  isCodingApplyQuery,
  isCodingReviewQuery,
  isCodingTaskPrepare,
  isCodingTaskReserve,
  localRuntimeRecord,
  type LocalDecisionRef,
  type LocalDecisionReply,
} from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import type { OperationKey, OperationStatus, ProjectCard } from '../project-protocol.js';

const prefixes = {
  reserve: 'reserve-',
  prepare: 'prepare-',
  review: 'coding-review-',
  apply: 'coding-apply-',
};
function operationRef(q: OperationKey): LocalDecisionRef {
  const { workspaceId, roomId, requestId, operation } = q;
  const id =
    prefixes[operation] +
    createHash('sha256')
      .update(JSON.stringify([workspaceId, requestId]))
      .digest('hex');
  return { workspaceId, roomId, decisionId: id, runId: id };
}
async function verifiedCard(
  client: LocalRuntimeClient,
  ref: LocalDecisionRef,
  allowed: readonly string[],
): Promise<ProjectCard> {
  const before = await client.getDecision(ref);
  if (!allowed.includes(before.kind)) throw Error('decision_scope_changed');
  const preview = await client.decisionPreview(ref);
  const after = await client.getDecision(ref);
  if (
    after.kind !== before.kind ||
    after.version !== before.version ||
    after.bindingDigest !== before.bindingDigest ||
    after.status !== before.status ||
    after.previewLength !== preview.length ||
    createHash('sha256').update(preview).digest('hex') !== after.bindingDigest
  )
    throw Error('version_conflict');
  return { decision: after, preview };
}

export async function operationCard(client: LocalRuntimeClient, q: OperationKey) {
  const ref = operationRef(q);
  const card = await verifiedCard(client, ref, ['project-setup']);
  const decoded: unknown = JSON.parse(card.preview);
  if (!localRuntimeRecord(decoded) || decoded['operation'] !== q.operation)
    throw Error('decision_scope_changed');
  const input = decoded['request'];
  if (
    !localRuntimeRecord(input) ||
    input['workspaceId'] !== q.workspaceId ||
    input['taskId'] !== q.taskId ||
    input['requestId'] !== q.requestId ||
    input[q.operation === 'reserve' ? 'ownerRoomId' : 'roomId'] !== q.roomId
  )
    throw Error('decision_scope_changed');
  return { ref, card, input };
}

export async function operationStatus(
  client: LocalRuntimeClient,
  q: OperationKey,
): Promise<OperationStatus> {
  // Never invoke the effect endpoint during recovery unless its durable exact card exists.
  const { input } = await operationCard(client, q);
  switch (q.operation) {
    case 'reserve':
      if (isCodingTaskReserve(input))
        return { operation: 'reserve', result: await client.reserveCodingTask(input) };
      break;
    case 'prepare':
      if (isCodingTaskPrepare(input))
        return { operation: 'prepare', result: await client.prepareCodingTask(input) };
      break;
    case 'review':
      if (isCodingReviewQuery(input))
        return { operation: 'review', result: await client.requestCodingReview(input) };
      break;
    case 'apply':
      if (isCodingApplyQuery(input))
        return { operation: 'apply', result: await client.applyCodingChangeset(input) };
      break;
  }
  throw Error('invalid_frame');
}

export function devCard(client: LocalRuntimeClient, ref: LocalDecisionRef) {
  return verifiedCard(client, ref, ['project-read', 'write', 'test']);
}

export async function vote(
  client: LocalRuntimeClient,
  ref: LocalDecisionRef,
  { decision }: ProjectCard,
  {
    choice,
    expectedVersion,
    bindingDigest,
  }: Pick<LocalDecisionReply, 'choice' | 'expectedVersion' | 'bindingDigest'>,
) {
  if (
    decision.status !== 'pending' ||
    decision.expiresAt <= Date.now() ||
    decision.version !== expectedVersion ||
    decision.bindingDigest !== bindingDigest
  )
    throw Error('version_conflict');
  return client.resolveDecision({ ...ref, choice, expectedVersion, bindingDigest });
}
