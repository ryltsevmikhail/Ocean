/* eslint-disable no-restricted-imports -- Test-only fakes for the same application package's provider ports. */
import type {
  ProviderConnectionReceipt,
  ProviderConnectionRecord,
  ProviderConnectionStorePort,
  ProviderCredential,
  ProviderCredentialPort,
  ProviderModelCapability,
  ProviderProbeResult,
  ProviderSecretRead,
  ProviderSecretStorePort,
} from '../src/provider-connection-ports.js';
import { legacyFixtureStore } from './model-connection-store.js';
import type { ProviderEvent, ProviderPort } from '../src/provider.js';

export interface FakeStore extends ProviderConnectionStorePort {
  readonly rows: Map<string, ProviderConnectionRecord>;
  readonly receipts: Map<string, ProviderConnectionReceipt>;
}
export function fakeStore(): FakeStore {
  const canonical = legacyFixtureStore();
  const rows = canonical.rows;
  const receipts = canonical.legacyReceipts;
  const clone = <T>(value: T): T => structuredClone(value);
  function put(record: ProviderConnectionRecord, expected: number | null): void {
    const current = rows.get(record.provider);
    if ((current?.revision ?? null) !== expected) throw Error('revision_conflict');
    rows.set(record.provider, clone(record));
  }
  return {
    rows,
    receipts,
    connections: canonical.store,
    read: (provider) => {
      const row = rows.get(provider);
      return row === undefined ? null : clone(row);
    },
    put,
    activate(record, expected, receipt) {
      put(record, expected);
      receipts.set(receipt.requestId, clone(receipt.value));
    },
    receipt: (requestId) => {
      const value = receipts.get(requestId);
      return value === undefined ? null : clone(value);
    },
  };
}

export interface FakeSecrets extends ProviderSecretStorePort {
  readonly values: Map<string, string>;
  readOverride: ((ref: string) => ProviderSecretRead | null) | null;
  writeFailure: Error | null;
  replaceFailure: Error | null;
  removeFailure: Error | null;
  readonly writes: string[];
  readonly replaces: { previous: string | null; ref: string }[];
}
export function fakeSecrets(): FakeSecrets {
  const values = new Map<string, string>();
  const secrets: FakeSecrets = {
    values,
    readOverride: null,
    writeFailure: null,
    replaceFailure: null,
    removeFailure: null,
    writes: [],
    replaces: [],
    read(ref) {
      const override = secrets.readOverride?.(ref);
      if (override !== null && override !== undefined) return override;
      const key = values.get(ref);
      return key === undefined ? { status: 'absent' } : { status: 'ok', key };
    },
    write(ref, key) {
      if (secrets.writeFailure) throw secrets.writeFailure;
      secrets.writes.push(ref);
      values.set(ref, key);
    },
    replace(previous, ref, key) {
      if (secrets.replaceFailure) throw secrets.replaceFailure;
      secrets.replaces.push({ previous, ref });
      if (previous !== null) values.delete(previous);
      values.set(ref, key);
    },
    remove(ref) {
      if (secrets.removeFailure) throw secrets.removeFailure;
      values.delete(ref);
    },
  };
  return secrets;
}

export interface FakeCredential extends ProviderCredential {
  readonly key: string;
}
export interface FakeProvider extends ProviderPort {
  readonly key: string;
  gate: Promise<void> | null;
  readonly calls: string[];
}
export interface FakeCredentials extends ProviderCredentialPort {
  readonly bound: FakeProvider[];
  readonly probes: { key: string; signal: AbortSignal }[];
  setEnvironment(value: ProviderCredential | null): void;
  probe: (key: string, signal: AbortSignal) => Promise<ProviderProbeResult>;
}
const MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
const CAPABILITIES: readonly ProviderModelCapability[] = [
  { model: 'deepseek-flash', imageInput: true },
  { model: 'deepseek-v4-pro', imageInput: false },
];
function fakeProvider(key: string): FakeProvider {
  const calls: string[] = [];
  const provider: FakeProvider = {
    key,
    calls,
    gate: null,
    id: 'deepseek',
    models: MODELS,
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream(request): AsyncGenerator<ProviderEvent> {
      calls.push(key + ':' + request.model);
      if (provider.gate !== null) await provider.gate;
      yield { type: 'text_delta', text: 'fixture ' + key };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  return provider;
}
export function fakeCredentials(models: readonly string[] = MODELS): FakeCredentials {
  const bound: FakeProvider[] = [];
  const probes: { key: string; signal: AbortSignal }[] = [];
  let environment: ProviderCredential | null = null;
  const credentials: FakeCredentials = {
    bound,
    probes,
    setEnvironment(value) {
      environment = value;
    },
    providerId: 'deepseek',
    models,
    modelCapabilities: CAPABILITIES.filter((capability) => models.includes(capability.model)),
    own(key) {
      const provider = fakeProvider(key);
      bound.push(provider);
      return { key, source: 'saved', provider, check: (signal) => credentials.probe(key, signal) };
    },
    environment: () => environment,
    async probe(key, signal) {
      probes.push({ key, signal });
      return { outcome: 'ok', httpStatus: 200, models: [...MODELS] };
    },
  };
  return credentials;
}
export function environmentCredential(): FakeCredential {
  const provider = fakeProvider('environment-key');
  return {
    key: 'environment-key',
    source: 'external',
    provider,
    check: async () => ({ outcome: 'ok', httpStatus: 200, models: [...MODELS] }),
  };
}
export function record(
  overrides: Partial<ProviderConnectionRecord> = {},
): ProviderConnectionRecord {
  return {
    provider: 'deepseek',
    model: 'deepseek-flash',
    secretRef: null,
    intent: 'active',
    revision: 1,
    requestId: null,
    binding: null,
    lastCheck: null,
    updatedAt: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}
