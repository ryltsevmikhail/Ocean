import {
  validModelConnectionEndpoint,
  type ModelCredentialFactory,
  type ModelConnectionDescriptor,
  type LocalModelMetadataCheck,
} from '@runnets/application';
import {
  createLocalProvider,
  checkLocalModel,
  copyLocalModelQualification,
  type LocalAuth,
} from '@runnets/provider-local';
import { ProviderError, type HttpClient } from '@runnets/provider-core';
/** No environment discovery and no placeholder provider/catalog. Preparation is I/O free. */
export function createLocalActivationFactory(httpClient?: HttpClient): ModelCredentialFactory {
  const acceptsDesired = (d: ModelConnectionDescriptor) =>
    d.providerId === 'ollama' &&
    d.kind === 'local' &&
    (d.auth === 'none' || d.auth === 'api_key') &&
    d.defaultModelId === 'qwen3:1.7b' &&
    validModelConnectionEndpoint('local', d.endpoint) &&
    new URL(d.endpoint).pathname === '/';
  const evidence = (d: ModelConnectionDescriptor) => {
    if (!acceptsDesired(d) || !d.localQualification) return null;
    try {
      const q = copyLocalModelQualification(d.localQualification);
      return q.modelId === d.defaultModelId ? q : null;
    } catch {
      return null;
    }
  };
  const prepareCheck: NonNullable<ModelCredentialFactory['localBootstrap']>['prepareCheck'] = (
    d,
    secret,
  ) => {
    if (
      !acceptsDesired(d) ||
      (d.auth === 'api_key' && secret?.status !== 'ok') ||
      (d.auth === 'none' && secret !== null)
    )
      return null;
    const auth: LocalAuth =
      d.auth === 'none'
        ? { mode: 'none' }
        : { mode: 'api_key', key: secret!.status === 'ok' ? secret!.key : '' };
    const source = d.auth === 'none' ? 'auth_none' : 'saved';
    const endpoint = d.endpoint!;
    const check: LocalModelMetadataCheck = {
      source,
      check: async (signal) => {
        try {
          return {
            outcome: 'ok',
            httpStatus: 200,
            qualification: await checkLocalModel(
              { endpoint, auth, ...(httpClient ? { httpClient } : {}) },
              signal,
            ),
          };
        } catch (error) {
          const code = error instanceof ProviderError ? error.code : 'unknown';
          return {
            outcome:
              code === 'auth' ||
              code === 'network' ||
              code === 'timeout' ||
              code === 'cancelled' ||
              code === 'server'
                ? code
                : 'unavailable',
            httpStatus: error instanceof ProviderError ? error.status : null,
          };
        }
      },
    };
    return check;
  };
  return {
    localBootstrap: { acceptsDesired, prepareCheck },
    catalog: (d) => {
      const q = evidence(d);
      return q ? [{ modelId: q.modelId, capabilities: q.capabilities }] : [];
    },
    activate: (d, secret) => {
      const q = evidence(d),
        check = prepareCheck(d, secret);
      if (!q || !check) return null;
      const auth: LocalAuth =
        d.auth === 'none'
          ? { mode: 'none' }
          : { mode: 'api_key', key: secret!.status === 'ok' ? secret!.key : '' };
      try {
        return {
          source: check.source,
          provider: createLocalProvider({
            endpoint: d.endpoint!,
            auth,
            qualification: q,
            ...(httpClient ? { httpClient } : {}),
          }),
          check: async (signal) => {
            const result = await check.check(signal);
            return result.outcome === 'ok'
              ? {
                  outcome: 'ok',
                  httpStatus: result.httpStatus,
                  models: [result.qualification.modelId],
                }
              : { ...result, models: [] };
          },
        };
      } catch {
        return null;
      }
    },
    external: () => null,
  };
}
