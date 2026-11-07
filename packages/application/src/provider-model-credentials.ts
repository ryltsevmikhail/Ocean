import type {
  ModelCredentialFactory,
  ModelConnectionDescriptor,
} from './model-credential-ports.js';
import type { ProviderCredentialPort } from './provider-connection-ports.js';
/** Compatibility translator over the host's existing immutable credential adapters. */
export function providerModelCredentials(
  credentials: ProviderCredentialPort,
): ModelCredentialFactory {
  const supported = (d: ModelConnectionDescriptor) =>
    d.providerId === credentials.providerId &&
    d.kind === 'cloud' &&
    d.auth === 'api_key' &&
    (d.providerId !== 'deepseek' || d.endpoint === 'https://api.deepseek.com');
  return {
    catalog: (descriptor) =>
      !supported(descriptor)
        ? []
        : credentials.models.map((modelId) => ({
            modelId,
            capabilities: {
              tools: false,
              streaming: true,
              inputModalities: credentials.modelCapabilities.some(
                (m) => m.model === modelId && m.imageInput,
              )
                ? ['text', 'image']
                : ['text'],
              contextTokens: null,
              maxOutputTokens: null,
              usage: 'reported',
            },
          })),
    activate: (descriptor, secret) =>
      supported(descriptor) && secret?.status === 'ok' ? credentials.own(secret.key) : null,
    external: (descriptor) => (supported(descriptor) ? credentials.environment() : null),
  };
}
