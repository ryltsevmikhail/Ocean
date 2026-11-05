import { expect, it } from 'vitest';
import { checkLocalModel } from './index.js';
import { endpoint, fixture, show, tags } from '../test-fixtures/http.js';

// Projection of Task 17.4's downloaded full-digest native metadata, not live evidence.
// Reinstating the provisional marketing-size guard must refuse this real artifact.
const details = { ...show.details, parameter_size: '2.0B' };
const artifactDigest = '8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7';
function candidate(parameterSize: unknown = '2.0B') {
  const nativeDetails = { ...details, parameter_size: parameterSize };
  return fixture({
    '/api/version': { version: '0.40.14' },
    '/api/tags': {
      models: [
        { ...tags.models[0], size: 1359293444, digest: artifactDigest, details: nativeDetails },
      ],
    },
    '/api/show': { ...show, details: nativeDetails },
  });
}
it('admits the native qwen3:1.7b artifact whose GGUF metadata reports 2.0B', async () => {
  const native = candidate();
  const qualified = await checkLocalModel(
    { endpoint, auth: { mode: 'none' }, httpClient: native.http },
    new AbortController().signal,
  );
  expect(qualified).toMatchObject({
    modelId: 'qwen3:1.7b',
    artifactDigest,
    backendVersion: '0.40.14',
    configuredContextTokens: 4096,
  });
});
it.each(['1.7B', '2.03B', '7B', '', null, ['2.0B'], { size: '2.0B' }])(
  'refuses a different or nonscalar parameter identity %j',
  async (parameterSize) => {
    const native = candidate(parameterSize);
    await expect(
      checkLocalModel(
        { endpoint, auth: { mode: 'none' }, httpClient: native.http },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', dispatch: 'not_sent', retryable: false });
    expect(native.requests.some((request) => request.url.endsWith('/api/chat'))).toBe(false);
  },
);
