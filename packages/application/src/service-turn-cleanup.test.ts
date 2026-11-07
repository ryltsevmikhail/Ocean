import { expect, it } from 'vitest';
import { PLUGIN_MAX_MODEL_OUTPUT_BYTES } from '@runnets/domain';
import type { ServicePluginInvokeOutcome } from './service-plugin-transport.js';
import { serviceResult } from './service-turn-tools-schema.js';
const outcomes: ServicePluginInvokeOutcome[] = [
  {
    kind: 'observed',
    code: 'ok',
    invocationId: 'i',
    vendorErrorCode: null,
    result: { received: true },
  },
  {
    kind: 'observed',
    code: 'vendor_error',
    invocationId: 'i',
    vendorErrorCode: 'vendor_rejected',
    result: { rejected: true },
  },
  { kind: 'not_started', code: 'execution_disabled', invocationId: 'i', detail: 'not sent' },
  { kind: 'uncertain', code: 'transport_failure', invocationId: 'i', detail: 'reply lost' },
];
it.each(outcomes)(
  'keeps $kind/$code truth distinct from private cleanup failure and stops further work',
  (outcome) => {
    const cleanupError = new AggregateError(
      [Error('/private/proof/path STACK_SECRET')],
      'PRIVATE_CLEANUP_MESSAGE',
    );
    const mapped = serviceResult({ code: outcome.code, outcome, cleanupError });
    expect(mapped.isError).toBe(true);
    expect(mapped.uncertain).toBe(true);
    expect(mapped.output).toContain('UNCONFIRMED CLEANUP');
    expect(mapped.output).not.toContain('STACK_SECRET');
    expect(mapped.output).not.toContain('/private');
    expect(mapped.output).not.toContain('PRIVATE_CLEANUP_MESSAGE');
    if (outcome.kind === 'observed') {
      expect(mapped.output).toContain('Service result observed (' + outcome.code + ')');
      expect(mapped.output).toContain(JSON.stringify(outcome.result));
      expect(mapped.output).not.toContain('Service outcome unknown');
    } else if (outcome.kind === 'not_started') {
      expect(mapped.output).toContain('did not start');
      expect(mapped.output).not.toContain('Service outcome unknown');
    } else expect(mapped.output).toContain('Service outcome unknown');
  },
);
it('keeps the safe cleanup warning and observed status inside the existing model output cap', () => {
  const outcome = {
    kind: 'observed' as const,
    code: 'ok' as const,
    invocationId: 'i',
    vendorErrorCode: null,
    result: { value: '猫'.repeat(PLUGIN_MAX_MODEL_OUTPUT_BYTES) },
  };
  const mapped = serviceResult({
    code: 'ok',
    outcome,
    cleanupError: new AggregateError([Error('PRIVATE')]),
  });
  expect(Buffer.byteLength(mapped.output)).toBeLessThanOrEqual(PLUGIN_MAX_MODEL_OUTPUT_BYTES);
  expect(mapped.output).toContain('UNCONFIRMED CLEANUP');
  expect(mapped.output).toContain('Service result observed (ok)');
  expect(mapped.output).not.toContain('PRIVATE');
});

it('does not turn an ambiguous claim refusal into a proved-not-started result during cleanup failure', () => {
  const result = serviceResult({
    code: 'claim_refused',
    outcome: null,
    cleanupError: new AggregateError([Error('PRIVATE')]),
  });
  expect(result.output).toContain('Service outcome unknown');
  expect(result.output).not.toContain('did not start');
  expect(result.output).toContain('UNCONFIRMED CLEANUP');
  expect(result.uncertain).toBe(true);
});
