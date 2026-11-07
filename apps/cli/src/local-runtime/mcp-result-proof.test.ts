import { expect, it } from 'vitest';
import { verifyNormalResult } from '../../test-fixtures/mcp-result-proof.js';
it.each(['http', 'stdio'])(
  'requires actual %s tool results instead of a fixed final answer',
  (mode) => {
    const expected = mode === 'stdio' ? 'owned synthetic canary\n' : 'synthetic result';
    expect(() =>
      verifyNormalResult(mode, JSON.stringify({ content: [{ type: 'text', text: expected }] })),
    ).not.toThrow();
    for (const content of [
      'service call refused (execution_disabled)',
      JSON.stringify({ isError: true, content: [{ type: 'text', text: expected }] }),
      JSON.stringify({ content: [{ type: 'text', text: 'wrong canary' }] }),
    ])
      expect(() => verifyNormalResult(mode, content)).toThrow();
  },
);
