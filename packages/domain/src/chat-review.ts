/** Acknowledgement records permission for future text, never a fact about the old effect. */
export interface ChatReview {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly taskRunId: string;
  readonly turnId: string;
  readonly actor: 'owner';
  readonly mode: 'text_only';
  readonly observedVersion: string;
  readonly reason: string;
  readonly noticeMessageId: string;
  readonly createdAt: string;
}
export interface RoomExecutionPolicy {
  readonly roomId: string;
  readonly mode: 'text_only';
  readonly reviewId: string;
}
