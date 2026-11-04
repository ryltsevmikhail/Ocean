/** Strict new-command validation and whitelist serialization. Historical events are unchanged. */
import { DomainError } from './errors.js';
import type { TokenUsagePayload } from './events.js';
import type {
  ModelActivationSnapshot,
  ModelCompletionEvidence,
  ModelUsageEvidence,
  StartModelRequestPayload,
  SettleModelRequestPayload,
} from './model-dispatch.js';

export function requireModel(condition: boolean, message: string): asserts condition {
  if (!condition) throw DomainError.invalidArgument(message);
}
function record(value: unknown): Record<string, unknown> {
  requireModel(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'expected model evidence object',
  );
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  requireModel(typeof value === 'string' && value.trim().length > 0, 'expected nonempty string');
  return value;
}
export function count(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  requireModel(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    'invalid model evidence count',
  );
  return value;
}
function choice<const T extends string>(value: unknown, choices: readonly T[]): T {
  requireModel(
    typeof value === 'string' && choices.includes(value as T),
    'invalid model evidence discriminant',
  );
  return value as T;
}
function boolean(value: unknown): boolean {
  requireModel(typeof value === 'boolean', 'expected boolean capability');
  return value;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
function nullableCount(value: unknown): number | null {
  return value === null ? null : count(value);
}
export function timestamp(value: unknown): string {
  const text = string(value);
  requireModel(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text),
    'invalid UTC timestamp',
  );
  const time = Date.parse(text);
  const normalized = text.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`,
  );
  requireModel(
    Number.isFinite(time) && new Date(time).toISOString() === normalized,
    'invalid UTC calendar timestamp',
  );
  return text;
}
export function copyActivation(value: unknown): ModelActivationSnapshot {
  const p = record(value),
    i = record(p.identity),
    c = record(p.capabilities),
    l = record(p.limits);
  requireModel(p.version === 1, 'unsupported activation version');
  const providerId = string(i.providerId),
    modelId = string(i.modelId);
  const source = choice(i.source, ['host', 'connection']);
  const identity: ModelActivationSnapshot['identity'] =
    source === 'host'
      ? { source, providerId, modelId }
      : {
          source,
          providerId,
          modelId,
          connectionId: string(i.connectionId),
          connectionRevision: count(i.connectionRevision),
          botProfileVersion: count(i.botProfileVersion, 1),
          kind: choice(i.kind, ['cloud', 'local']),
          endpoint: string(i.endpoint),
          auth: choice(i.auth, ['api_key', 'none']),
          artifactDigest: nullableString(i.artifactDigest),
          backendVersion: nullableString(i.backendVersion),
        };
  requireModel(Array.isArray(c.inputModalities), 'expected input modalities');
  const capabilities = {
    tools: boolean(c.tools),
    streaming: boolean(c.streaming),
    inputModalities: Array.from(c.inputModalities, (v: unknown) => choice(v, ['text', 'image'])),
    contextTokens: nullableCount(c.contextTokens),
    maxOutputTokens: nullableCount(c.maxOutputTokens),
    usage: choice(c.usage, ['reported', 'optional', 'unavailable']),
  };
  const limits = {
    maxModelRequests: count(l.maxModelRequests, 1, 64),
    requestTimeoutMs: count(l.requestTimeoutMs, 1, 600000),
    turnTimeoutMs: count(l.turnTimeoutMs, 1, 600000),
  };
  const admittedAt = timestamp(p.admittedAt),
    deadlineAt = timestamp(p.deadlineAt);
  requireModel(
    Date.parse(admittedAt) < Date.parse(deadlineAt) &&
      Date.parse(deadlineAt) - Date.parse(admittedAt) <= limits.turnTimeoutMs,
    'invalid activation deadline',
  );
  return { version: 1, identity, capabilities, limits, admittedAt, deadlineAt };
}
export function copyTokens(value: unknown): TokenUsagePayload {
  const p = record(value);
  return {
    inputTokens: count(p.inputTokens),
    outputTokens: count(p.outputTokens),
    totalTokens: count(p.totalTokens),
  };
}
function copyCompletion(value: unknown): ModelCompletionEvidence {
  const p = record(value),
    kind = choice(p.kind, ['terminal', 'rejected', 'not_sent', 'unknown']);
  return kind === 'terminal'
    ? {
        kind,
        stopReason: choice(p.stopReason, [
          'stop',
          'length',
          'content_filter',
          'tool_calls',
          'cancelled',
          'unknown',
        ]),
      }
    : { kind };
}
function copyUsage(value: unknown): ModelUsageEvidence {
  const p = record(value),
    kind = choice(p.kind, ['actual', 'estimated', 'unavailable']);
  if (kind === 'unavailable')
    return { kind, reason: choice(p.reason, ['unsupported', 'not_reported', 'interrupted']) };
  const tokens = copyTokens(p.tokens);
  return kind === 'actual' ? { kind, tokens } : { kind, tokens, estimator: string(p.estimator) };
}
export function copyStart(value: unknown): StartModelRequestPayload {
  const p = record(value);
  return {
    attemptId: string(p.attemptId),
    ordinal: count(p.ordinal, 1),
    activation: copyActivation(p.activation),
    startedAt: timestamp(p.startedAt),
  };
}
export function copySettlement(value: unknown): SettleModelRequestPayload {
  const p = record(value);
  return {
    attemptId: string(p.attemptId),
    ordinal: count(p.ordinal, 1),
    finishedAt: timestamp(p.finishedAt),
    completion: copyCompletion(p.completion),
    usage: copyUsage(p.usage),
  };
}
/** Canonical named-field copies make key insertion order irrelevant and exclude extra input. */
export function sameActivation(a: ModelActivationSnapshot, b: ModelActivationSnapshot): boolean {
  return JSON.stringify(copyActivation(a)) === JSON.stringify(copyActivation(b));
}
