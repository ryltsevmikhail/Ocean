import { appendFileSync } from 'node:fs';
import process from 'node:process';
// Owner-only metadata responses. No network fallback, even for unexpected requests.
const details = {
  format: 'gguf',
  family: 'qwen3',
  families: ['qwen3'],
  parameter_size: '2.0B',
  quantization_level: 'Q4_K_M',
};
const local = 'http://127.0.0.1:11434/api/';
const responses = new Map([
  [
    'GET https://api.deepseek.com/models',
    {
      object: 'list',
      data: [
        { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
        { id: 'deepseek-v4-pro', input_modalities: ['text'] },
      ],
    },
  ],
  ['GET ' + local + 'version', { version: 'synthetic-native-qa' }],
  [
    'GET ' + local + 'tags',
    {
      models: [
        { name: 'qwen3:1.7b', model: 'qwen3:1.7b', digest: 'a'.repeat(64), size: 1024, details },
      ],
    },
  ],
  [
    'POST ' + local + 'show',
    {
      details,
      capabilities: ['completion', 'tools'],
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 },
      tensors: [{ name: 'fixture', type: 'Q4_K', shape: [1] }],
    },
  ],
]);
globalThis.fetch = async (url, options = {}) => {
  const route = (options.method ?? 'GET') + ' ' + String(url);
  const served = responses.has(route);
  appendFileSync(process.env.OCEAN_NATIVE_REQUESTS, JSON.stringify({ route, served }) + '\n');
  if (!served) throw Error('unexpected synthetic transport request');
  return globalThis.Response.json(responses.get(route));
};
