import { copyBotModelBinding, type Bot, type ModelExecutionIdentity } from '@runnets/domain';
import { validLocalModelBackendVersion } from './model-local-qualification.js';
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
  const identity = {
    source: 'connection' as const,
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
  return validRoomTaskIdentity(identity) ? identity : null;
}

/** Exact stored projection, shared by admission and SQLite decode; B text units stay unchanged. */
export function validRoomTaskIdentity(
  value: unknown,
): value is Extract<ModelExecutionIdentity, { source: 'connection' }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const i = value as Record<string, unknown>;
  try {
    copyBotModelBinding(i);
  } catch {
    return false;
  }
  return (
    Object.keys(i).sort().join() ===
      'artifactDigest,auth,backendVersion,botProfileVersion,connectionId,connectionRevision,endpoint,kind,modelId,providerId,source' &&
    i['source'] === 'connection' &&
    typeof i['providerId'] === 'string' &&
    i['providerId'].length > 0 &&
    !i['providerId'].includes('\0') &&
    Number.isSafeInteger(i['connectionRevision']) &&
    Number(i['connectionRevision']) >= 1 &&
    Number.isSafeInteger(i['botProfileVersion']) &&
    Number(i['botProfileVersion']) >= 1 &&
    (i['kind'] === 'cloud' || i['kind'] === 'local') &&
    validModelConnectionEndpoint(i['kind'], i['endpoint']) &&
    (i['auth'] === 'api_key' || (i['kind'] === 'local' && i['auth'] === 'none')) &&
    (i['kind'] === 'cloud'
      ? i['artifactDigest'] === null && i['backendVersion'] === null
      : typeof i['artifactDigest'] === 'string' &&
        /^[0-9a-f]{64}$/.test(i['artifactDigest']) &&
        validLocalModelBackendVersion(i['backendVersion']))
  );
}
