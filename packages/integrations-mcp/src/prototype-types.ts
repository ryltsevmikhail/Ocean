import type { ServicePluginInvokeOutcome } from '@runnets/application';
import { Client, type Tool } from '@modelcontextprotocol/client';

export interface Case {
  name: string;
  status: 'passed' | 'failed' | 'unqualified';
  outcome: null | ServicePluginInvokeOutcome['kind'];
  sdkAttempts: number;
  metadataAttempts: number;
  businessAttempts: number;
  observedEffects: number;
  detail: string;
}
export const empty = (name: string): Case => ({
  name,
  status: 'unqualified',
  outcome: null,
  sdkAttempts: 0,
  metadataAttempts: 0,
  businessAttempts: 0,
  observedEffects: 0,
  detail: '',
});
export function client(modern: boolean) {
  return new Client(
    { name: 'ocean-qualification', version: '0.0.0' },
    {
      capabilities: {},
      inputRequired: { autoFulfill: false },
      defaultCacheTtlMs: 0,
      versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
    },
  );
}
export function immutable(tool: Tool): Tool {
  const copy = structuredClone(tool);
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}
export const methodOf = (init?: RequestInit): string =>
  typeof init?.body === 'string'
    ? ((JSON.parse(init.body) as { method?: string }).method ?? 'response')
    : (init?.method ?? 'GET');
