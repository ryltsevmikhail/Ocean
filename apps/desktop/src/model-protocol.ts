import { z } from 'zod';
import {
  isLocalModelConnectionsQuery,
  isLocalModelConnectionsPage,
  isLocalModelConnectionSetRequest,
  isLocalModelConnectionRevisionRequest,
  isLocalModelConnectionQuery,
  isLocalModelConnectionStatus,
  isLocalModelConnectionCheckResponse,
  isLocalCreateBoundBotRequest,
  isLocalSetBotModelBindingRequest,
  isLocalBoundBot,
  isLocalBoundBotsQuery,
  isLocalBoundBotsPage,
  isLocalModelRunQuery,
  isLocalRunModelExecution,
} from '@runnets/contracts';
export type {
  LocalModelConnectionMetadata,
  LocalModelConnectionSetRequest,
  LocalModelPendingRequest,
  LocalBotModelBinding,
  LocalBoundBot,
  LocalRunModelExecution,
} from '@runnets/contracts';
// Reuse the public closed validators, then detach validated values at both IPC boundaries.
const dto = <T>(guard: (v: unknown) => v is T) =>
  z.custom<T>(guard).transform((value, ctx) => {
    // Validated JSON DTOs may originate in Vue proxies. Revalidate after detaching;
    // serialization never grants additional fields or substitutes primitive evidence.
    let copy: unknown;
    try {
      copy = JSON.parse(JSON.stringify(value));
    } catch {
      copy = undefined;
    }
    if (!guard(copy)) {
      ctx.addIssue({ code: 'custom', message: 'invalid DTO' });
      return z.NEVER;
    }
    return copy;
  });
const scope = <T extends { workspaceId?: string }>(guard: (v: unknown) => v is T) =>
  dto((v: unknown): v is T => guard(v) && v.workspaceId === 'ws_ocean');
export const modelCommands = [
  z.strictObject({ op: z.literal('model-support') }),
  z.strictObject({ op: z.literal('model-presets') }),
  z.strictObject({
    op: z.literal('model-connections'),
    input: scope(isLocalModelConnectionsQuery),
  }),
  z.strictObject({ op: z.literal('model-set'), input: dto(isLocalModelConnectionSetRequest) }),
  z.strictObject({ op: z.literal('model-check'), input: dto(isLocalModelConnectionQuery) }),
  z.strictObject({
    op: z.literal('model-disconnect'),
    input: dto(isLocalModelConnectionRevisionRequest),
  }),
  z.strictObject({
    op: z.literal('model-remove-key'),
    input: dto(isLocalModelConnectionRevisionRequest),
  }),
  z.strictObject({ op: z.literal('bot-bound-create'), input: scope(isLocalCreateBoundBotRequest) }),
  z.strictObject({
    op: z.literal('bot-binding-set'),
    input: scope(isLocalSetBotModelBindingRequest),
  }),
  z.strictObject({ op: z.literal('bound-bots'), input: scope(isLocalBoundBotsQuery) }),
  z.strictObject({ op: z.literal('model-execution'), input: scope(isLocalModelRunQuery) }),
] as const;
const preset = z.strictObject({
  providerId: z.string().min(1).max(64),
  kind: z.enum(['cloud', 'local']),
  endpoint: z.string().max(2048),
  models: z.array(z.string().min(1).max(256)).max(200),
});
export const modelOutputs = {
  'model-support': z.strictObject({ connections: z.boolean() }),
  'model-presets': z.array(preset).max(10),
  'model-connections': dto(isLocalModelConnectionsPage),
  'model-set': dto(isLocalModelConnectionStatus),
  'model-check': dto(isLocalModelConnectionCheckResponse),
  'model-disconnect': dto(isLocalModelConnectionStatus),
  'model-remove-key': dto(isLocalModelConnectionStatus),
  'bot-bound-create': dto(isLocalBoundBot),
  'bot-binding-set': dto(isLocalBoundBot),
  'bound-bots': dto(isLocalBoundBotsPage),
  'model-execution': dto(isLocalRunModelExecution),
};
export type ModelCommand = z.infer<(typeof modelCommands)[number]>;
export type ModelPreset = z.infer<typeof preset>;
