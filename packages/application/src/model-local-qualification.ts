import type { ModelCapabilities } from '@runnets/domain';
export interface LocalModelQualification {
  readonly modelId: string;
  readonly artifactDigest: string;
  readonly backendVersion: string;
  readonly capabilities: ModelCapabilities;
  readonly configuredContextTokens: number;
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export const validLocalModelBackendVersion = (value: unknown): value is string => text(value, 128);
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
/** Closed detached evidence; malformed present data is never converted to qualification. */
export function copyLocalQualification(value: unknown): LocalModelQualification {
  if (
    !object(value) ||
    !text(value['modelId'], 256) ||
    !validLocalModelBackendVersion(value['backendVersion']) ||
    typeof value['artifactDigest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['artifactDigest']) ||
    !positive(value['configuredContextTokens'])
  )
    throw Error('connection_unverified');
  const c = value['capabilities'];
  if (
    !object(c) ||
    typeof c['tools'] !== 'boolean' ||
    typeof c['streaming'] !== 'boolean' ||
    !Array.isArray(c['inputModalities']) ||
    c['inputModalities'].length < 1 ||
    c['inputModalities'].length > 2 ||
    !c['inputModalities'].includes('text') ||
    c['inputModalities'].some((v: unknown) => v !== 'text' && v !== 'image') ||
    new Set(c['inputModalities']).size !== c['inputModalities'].length ||
    c['contextTokens'] !== value['configuredContextTokens'] ||
    (c['maxOutputTokens'] !== null && !positive(c['maxOutputTokens'])) ||
    typeof c['usage'] !== 'string' ||
    (c['usage'] !== 'reported' && c['usage'] !== 'optional' && c['usage'] !== 'unavailable')
  )
    throw Error('connection_unverified');
  return {
    modelId: value['modelId'],
    artifactDigest: value['artifactDigest'],
    backendVersion: value['backendVersion'],
    configuredContextTokens: value['configuredContextTokens'],
    capabilities: {
      tools: c['tools'],
      streaming: c['streaming'],
      inputModalities: c['inputModalities'].includes('image') ? ['text', 'image'] : ['text'],
      contextTokens: value['configuredContextTokens'],
      maxOutputTokens: c['maxOutputTokens'],
      usage: c['usage'],
    },
  };
}
export function sameLocalQualification(
  a: LocalModelQualification | null,
  b: LocalModelQualification,
): boolean {
  return (
    a !== null &&
    JSON.stringify(copyLocalQualification(a)) === JSON.stringify(copyLocalQualification(b))
  );
}
