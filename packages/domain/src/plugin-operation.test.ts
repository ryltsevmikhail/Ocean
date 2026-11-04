import { describe, expect, it } from 'vitest';
import {
  PLUGIN_MAX_CALLS_PER_TURN,
  PLUGIN_MAX_MODEL_OUTPUT_BYTES,
  boundPluginArguments,
  boundPluginDetail,
  pluginOperationTerminal,
  pluginTruncationMarker,
  sliceTextByBytes,
  truncatePluginOutput,
  utf8Bytes,
  validPluginOperationId,
  validPluginOperationState,
} from './plugin-operation.js';

describe('plugin operation model', () => {
  it('pins the RC2 pilot limits', () => {
    expect(PLUGIN_MAX_CALLS_PER_TURN).toBe(16);
    expect(PLUGIN_MAX_MODEL_OUTPUT_BYTES).toBe(32 * 1024);
  });

  it('counts UTF-8 bytes without a platform buffer', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('и')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
    expect(utf8Bytes('')).toBe(0);
  });

  it('keeps short output untouched', () => {
    const bounded = truncatePluginOutput('{"ok":true}');
    expect(bounded).toEqual({
      text: '{"ok":true}',
      truncated: false,
      totalBytes: 11,
      keptBytes: 11,
    });
  });

  it('truncates to the exact byte bound with an explicit marker and byte counts', () => {
    const text = 'и'.repeat(40000); // 80000 bytes
    const bounded = truncatePluginOutput(text, 32768);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totalBytes).toBe(80000);
    expect(bounded.keptBytes).toBeLessThan(32768);
    expect(utf8Bytes(bounded.text)).toBeLessThanOrEqual(32768);
    expect(bounded.text.endsWith(pluginTruncationMarker(bounded.keptBytes, 80000))).toBe(true);
    expect(bounded.text).toContain('[truncated: kept ');
    // No broken multibyte character at the cut.
    expect(bounded.text.startsWith(sliceTextByBytes(text, bounded.keptBytes))).toBe(true);
  });

  it('never exceeds the bound for the smallest interesting budgets', () => {
    for (const budget of [64, 65, 128, 1000]) {
      const bounded = truncatePluginOutput('x'.repeat(5000), budget);
      expect(utf8Bytes(bounded.text)).toBeLessThanOrEqual(budget);
      expect(bounded.truncated).toBe(true);
    }
  });

  it('slices text on code-point boundaries', () => {
    expect(sliceTextByBytes('абв', 3)).toBe('а');
    expect(sliceTextByBytes('abc', 2)).toBe('ab');
    expect(sliceTextByBytes('abc', 0)).toBe('');
  });

  it('bounds stored diagnostics and argument copies', () => {
    expect(boundPluginDetail('a '.repeat(1000))).toMatch(/…$/);
    const big = JSON.stringify({ body: 'x'.repeat(10_000) });
    const stored = boundPluginArguments(big);
    expect(stored.length).toBeLessThan(big.length);
    expect(JSON.parse(stored)).toEqual({ truncated: true, bytes: utf8Bytes(big) });
  });

  it('validates operation states and identities', () => {
    expect(validPluginOperationState('uncertain')).toBe(true);
    expect(validPluginOperationState('done')).toBe(false);
    expect(validPluginOperationId('attempt_plugin_call-1')).toBe(true);
    expect(validPluginOperationId('')).toBe(false);
    expect(pluginOperationTerminal('observed')).toBe(true);
    expect(pluginOperationTerminal('uncertain')).toBe(false);
    expect(pluginOperationTerminal('acknowledged')).toBe(false);
  });
});
