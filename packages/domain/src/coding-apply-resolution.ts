/** An owner accepts an observed snapshot; the original effect outcome remains uncertain. */
export interface CodingApplyResolution {
  readonly applicationId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly changesetHash: string;
  readonly baseCommit: string;
  readonly ownerId: string;
  readonly accepted: 'before' | 'after';
  readonly treeHash: string;
  readonly effectFingerprint: string;
  readonly reason: string;
  readonly decidedAt: string;
}
