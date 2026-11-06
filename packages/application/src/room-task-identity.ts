import { type Bot, type ModelExecutionIdentity } from '@runnets/domain';
import type { ConversationTransaction } from './conversation-ports.js';
import { validModelConnectionEndpoint } from './model-connection-input.js';
/** Project configured metadata only. Credentials, providers and deadlines are inaccessible. */
export function roomTaskIdentity(
  tx: ConversationTransaction,
  bot: Bot,
): Extract<ModelExecutionIdentity, { source: 'connection' }> | null {
  const b = tx.modelBinding(bot.id),
    r = b && tx.roomTasks?.modelConnection(b.connectionId);
  if (
    !b ||
    !r ||
    r.intent !== 'active' ||
    r.revision < 1 ||
    r.pendingSecretChange !== null ||
    (r.pendingRequest !== undefined && r.pendingRequest !== null) ||
    r.providerId !== bot.provider ||
    b.modelId !== bot.model ||
    !validModelConnectionEndpoint(r.kind, r.endpoint) ||
    (r.kind === 'local' && (!r.localQualification || r.localQualification.modelId !== b.modelId))
  )
    return null;
  return {
    source: 'connection',
    ...b,
    providerId: r.providerId,
    connectionRevision: r.revision,
    botProfileVersion: bot.profileVersion,
    kind: r.kind,
    endpoint: r.endpoint,
    auth: r.auth,
    artifactDigest: r.localQualification?.artifactDigest ?? null,
    backendVersion: r.localQualification?.backendVersion ?? null,
  };
}
