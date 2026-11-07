import { z } from 'zod';
import {
  isLocalServiceConnectionRequest,
  isLocalServiceConnectionSetRequest,
  isLocalServiceGrantSetRequest,
  isLocalServiceGrantRevokeRequest,
  isLocalServiceReceiptQuery,
  isLocalServiceOwnerOperationsQuery,
  isLocalServiceOwnerReceipt,
  isLocalServiceGrants,
  normalizeLocalServiceConnections,
  isLocalServiceOwnerOperationsPage,
  isLocalRoomListQuery,
  isDecisionRef,
  isDecisionReply,
  isLocalDecision,
  type LocalServiceGrantSetRequest,
  type LocalServiceConnectionView,
  type LocalServiceOwnerReceipt,
} from '@runnets/contracts';
import { taskBinding } from './room-task-protocol.js';
import { dto } from './protocol-dto.js';
const scoped = <T extends { workspaceId: string }>(guard: (v: unknown) => v is T) =>
  dto((v: unknown): v is T => guard(v) && v.workspaceId === 'ws_ocean');
export const serviceCommands = [
  z.strictObject({ op: z.literal('service-support') }),
  z.strictObject({ op: z.literal('service-connections') }),
  z.strictObject({ op: z.literal('service-grants'), binding: taskBinding.optional() }),
  z.strictObject({ op: z.literal('service-receipt'), input: dto(isLocalServiceReceiptQuery) }),
  z.strictObject({ op: z.literal('service-set'), input: dto(isLocalServiceConnectionSetRequest) }),
  z.strictObject({
    op: z.literal('service-disconnect'),
    input: dto(isLocalServiceConnectionRequest),
  }),
  z.strictObject({ op: z.literal('service-refresh'), input: dto(isLocalServiceConnectionRequest) }),
  z.strictObject({
    op: z.literal('service-grant'),
    input: dto(isLocalServiceGrantSetRequestScope),
  }),
  z.strictObject({ op: z.literal('service-revoke'), input: dto(isLocalServiceGrantRevokeRequest) }),
  z.strictObject({
    op: z.literal('service-operations'),
    input: dto(isLocalServiceOwnerOperationsQuery),
  }),
  z.strictObject({ op: z.literal('service-decisions'), input: scoped(isLocalRoomListQuery) }),
  z.strictObject({
    op: z.literal('service-decision'),
    binding: taskBinding.optional(),
    input: scoped(isDecisionRef),
  }),
  z.strictObject({
    op: z.literal('service-preview'),
    binding: taskBinding.optional(),
    input: scoped(isDecisionRef),
  }),
  z.strictObject({
    op: z.literal('service-resolve'),
    binding: taskBinding.optional(),
    input: scoped(isDecisionReply),
  }),
] as const;
// A grant's workspace is nested; the public guard validates the complete intent.
function isLocalServiceGrantSetRequestScope(v: unknown): v is LocalServiceGrantSetRequest {
  return isLocalServiceGrantSetRequest(v) && v.intent.subject.workspaceId === 'ws_ocean';
}
const connections = dto(
  (v: unknown): v is readonly LocalServiceConnectionView[] =>
    normalizeLocalServiceConnections(v) !== null,
).transform((v) => normalizeLocalServiceConnections(v)!);
export const serviceOutputs = {
  'service-support': z.strictObject({
    current: z.boolean(),
    historical: z.boolean(),
    historicalOnly: z.boolean(),
    decisions: z.boolean(),
  }),
  'service-connections': connections,
  'service-grants': dto(isLocalServiceGrants),
  'service-receipt': dto(
    (v): v is LocalServiceOwnerReceipt | null => v === null || isLocalServiceOwnerReceipt(v),
  ),
  'service-set': dto(isLocalServiceOwnerReceipt),
  'service-disconnect': dto(isLocalServiceOwnerReceipt),
  'service-refresh': dto(isLocalServiceOwnerReceipt),
  'service-grant': dto(isLocalServiceOwnerReceipt),
  'service-revoke': dto(isLocalServiceOwnerReceipt),
  'service-operations': dto(isLocalServiceOwnerOperationsPage),
  'service-decisions': z.array(dto(isLocalDecision)).max(200),
  'service-decision': dto(isLocalDecision),
  'service-preview': z.string(),
  'service-resolve': dto(isLocalDecision),
};
export type ServiceCommand = z.infer<(typeof serviceCommands)[number]>;
