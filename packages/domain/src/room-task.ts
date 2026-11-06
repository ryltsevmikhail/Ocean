import type { OwnerGrantReference } from './owner-scope-grant.js';

/** Addressing projection of a bot task; not a persisted task schema or authority grant. */
export interface RoomTaskAddress {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly rootId: string;
  readonly parentId: string;
  readonly assigneeBotId: string;
  readonly members: readonly string[];
  readonly grantReferences: readonly OwnerGrantReference[];
  readonly status: 'ready' | 'waiting' | 'paused' | 'completed' | 'stopped';
  readonly lastDeliverySeq: number;
}
