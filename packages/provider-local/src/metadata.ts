import type { LocalModelQualification } from '@runnets/application';
import { MODEL, object, refuse, assertLocalOrigin } from './profile.js';
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= max &&
  ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function details(value: unknown): void {
  const d = object(value);
  if (
    !d ||
    d['format'] !== 'gguf' ||
    d['family'] !== 'qwen3' ||
    d['quantization_level'] !== 'Q4_K_M' ||
    !Array.isArray(d['families']) ||
    d['families'].length !== 1 ||
    d['families'][0] !== 'qwen3' ||
    d['parameter_size'] !== '1.7B'
  )
    refuse('unsupported local model details');
}
export function qualifyMetadata(
  version: Record<string, unknown>,
  tags: Record<string, unknown>,
  show: Record<string, unknown>,
): LocalModelQualification {
  assertLocalOrigin(version);
  assertLocalOrigin(tags);
  assertLocalOrigin(show);
  if (!bounded(version['version'], 128)) refuse('invalid backend version');
  const models = tags['models'];
  if (!Array.isArray(models) || models.length > 4096) refuse('invalid model list');
  const matches: Record<string, unknown>[] = [];
  for (const value of models) {
    const row = object(value);
    if (!row || !bounded(row['name'], 256) || !bounded(row['model'], 256))
      refuse('invalid model list');
    if (row['name'] === MODEL || row['model'] === MODEL) matches.push(row);
  }
  if (matches.length !== 1) refuse('local artifact absent or ambiguous');
  const row = matches[0]!;
  assertLocalOrigin(row);
  details(row['details']);
  details(show['details']);
  if (
    row['name'] !== MODEL ||
    row['model'] !== MODEL ||
    !positive(row['size']) ||
    typeof row['digest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row['digest'])
  )
    refuse('invalid local artifact identity');
  const caps = show['capabilities'],
    info = object(show['model_info']),
    tensors = show['tensors'];
  if (
    !Array.isArray(caps) ||
    caps.length > 32 ||
    caps.some((v: unknown) => !bounded(v, 64)) ||
    !caps.includes('completion') ||
    !caps.includes('tools') ||
    caps.includes('vision')
  )
    refuse('unsupported local capabilities');
  if (
    !info ||
    info['general.architecture'] !== 'qwen3' ||
    !positive(info['qwen3.context_length']) ||
    info['qwen3.context_length'] < 4096
  )
    refuse('insufficient local context evidence');
  if (!Array.isArray(tensors) || tensors.length === 0 || tensors.length > 16384)
    refuse('unknown local tensor origin');
  for (const value of tensors) {
    const t = object(value),
      shape = t?.['shape'];
    if (
      !t ||
      !bounded(t['name'], 512) ||
      !bounded(t['type'], 64) ||
      !Array.isArray(shape) ||
      shape.length < 1 ||
      shape.length > 8 ||
      shape.some((v: unknown) => !positive(v))
    )
      refuse('invalid local tensor evidence');
  }
  return {
    modelId: MODEL,
    artifactDigest: row['digest'],
    backendVersion: version['version'],
    configuredContextTokens: 4096,
    capabilities: {
      tools: true,
      streaming: true,
      inputModalities: ['text'],
      contextTokens: 4096,
      maxOutputTokens: null,
      usage: 'optional',
    },
  };
}
