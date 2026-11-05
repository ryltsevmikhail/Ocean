import assert from 'node:assert/strict';
import type { HttpResponse } from '@runnets/provider-core';
/** Synthetic supported-model metadata only; no local backend or inference call. */
export function localMetadata(url: URL): HttpResponse {
  assert.equal(url.origin, 'http://127.0.0.1:11434');
  const details = {
    format: 'gguf',
    family: 'qwen3',
    families: ['qwen3'],
    parameter_size: '2.0B',
    quantization_level: 'Q4_K_M',
  };
  const bodies: Record<string, unknown> = {
    '/api/version': { version: 'synthetic-policy-fixture' },
    '/api/tags': {
      models: [
        { name: 'qwen3:1.7b', model: 'qwen3:1.7b', digest: 'a'.repeat(64), size: 1024, details },
      ],
    },
    '/api/show': {
      details,
      capabilities: ['completion', 'tools'],
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 },
      tensors: [{ name: 'fixture', type: 'Q4_K', shape: [1] }],
    },
  };
  assert.equal(Object.hasOwn(bodies, url.pathname), true, 'unexpected local metadata request');
  const body = JSON.stringify(bodies[url.pathname]);
  return {
    status: 200,
    ok: true,
    text: async () => body,
    stream: async function* () {
      yield body;
    },
  };
}
