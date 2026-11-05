import type { HttpClient, HttpRequest } from '@runnets/provider-core';
export const endpoint = 'http://127.0.0.1:11434';
export const digest = 'a'.repeat(64);
export const details = {
  format: 'gguf',
  family: 'qwen3',
  families: ['qwen3'],
  quantization_level: 'Q4_K_M',
  parameter_size: '2.0B',
};
export const version = { version: 'fixture-0.1' };
export const tags = {
  models: [{ name: 'qwen3:1.7b', model: 'qwen3:1.7b', size: 1400000000, digest, details }],
};
export const show = {
  details,
  capabilities: ['completion', 'tools'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
  tensors: [{ name: 'token_embd.weight', type: 'Q4_K', shape: [2048, 151936] }],
};
export const qualification = {
  modelId: 'qwen3:1.7b',
  artifactDigest: digest,
  backendVersion: 'fixture-0.1',
  configuredContextTokens: 4096,
  capabilities: {
    tools: true,
    streaming: true,
    inputModalities: ['text'] as const,
    contextTokens: 4096,
    maxOutputTokens: null,
    usage: 'optional' as const,
  },
};
export function fixture(overrides: Record<string, unknown> = {}, chunks?: string[]) {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    async send(request) {
      requests.push(request);
      const path = new URL(request.url).pathname;
      const body =
        overrides[path] ??
        (
          { '/api/version': version, '/api/tags': tags, '/api/show': show } as Record<
            string,
            unknown
          >
        )[path];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        async *stream() {
          if (path === '/api/chat') {
            yield* chunks ?? [
              JSON.stringify({
                model: 'qwen3:1.7b',
                message: { role: 'assistant', content: 'hello' },
                done: true,
                done_reason: 'stop',
              }) + '\n',
            ];
          } else yield JSON.stringify(body);
        },
      };
    },
  };
  return { http, requests };
}
export const request = {
  model: 'qwen3:1.7b',
  messages: [{ role: 'user' as const, content: 'hi' }],
};
