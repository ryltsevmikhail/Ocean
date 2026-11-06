import { validCodingGrantBasis, type CodingApproval } from './coding-approval.js';

/** Storage adapters enforce immutable previews and irreversible decisions. */
export function assertCodingApprovalTransition(
  previous: CodingApproval | null,
  next: CodingApproval,
): void {
  if (next.roomBasis !== undefined && !validCodingGrantBasis(next.roomBasis))
    throw Error('invalid room basis');
  if (!previous) {
    if (next.status !== 'pending') throw Error('approval must start pending');
    return;
  }
  if (JSON.stringify({ ...previous, status: next.status }) !== JSON.stringify(next))
    throw Error('immutable approval binding');
  const allowed =
    previous.status === 'pending'
      ? next.status === 'allowed' || next.status === 'denied'
      : previous.status === 'allowed' && next.status === 'consumed';
  if (!allowed) throw Error('invalid approval transition');
}
export function codingApprovalClaimKey(approval: CodingApproval): string {
  const b = approval.binding;
  return JSON.stringify([
    b.workspaceId,
    b.taskId,
    b.roomId,
    b.botId,
    b.runId,
    b.attemptId,
    b.invocationId,
  ]);
}
