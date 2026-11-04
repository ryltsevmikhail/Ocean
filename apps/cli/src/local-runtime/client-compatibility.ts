import { LOCAL_PLUGIN_SESSION_AUTHORITY, type LocalRuntimeIdentity } from '@runnets/contracts';

/** Hello features describe wire support only; they never grant bot or tool authority. */
export function clientFeatures(params: Record<string, unknown>): readonly string[] | null {
  if (!('clientFeatures' in params)) return [];
  const features = params['clientFeatures'];
  return Array.isArray(features) &&
    features.length <= 16 &&
    features.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 64)
    ? features
    : null;
}

/** RC2 accepts at most 64 capabilities and cannot use the session-authority plugin API. */
export function clientIdentity<T extends LocalRuntimeIdentity>(identity: T, plugins: boolean): T {
  return plugins
    ? identity
    : { ...identity, capabilities: identity.capabilities.filter((c) => !c.startsWith('plugin.')) };
}
export function supportsPlugins(features: readonly string[]): boolean {
  return features.includes(LOCAL_PLUGIN_SESSION_AUTHORITY);
}
