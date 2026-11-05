import type { ServicePluginInvokeOutcome } from '@runnets/application';
export { client, immutable, methodOf } from './profile.js';

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
