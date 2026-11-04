/**
 * Pure outcome-classification tests. These pin the fail-closed mapping that the
 * transport uses after the single dispatch attempt:
 *
 * - returned results (including 4xx/vendor results) are `observed`,
 * - transport losses, 5xx and unknown no-status vendor codes are `uncertain`,
 * - dispatch failures/timeouts/interrupts are `uncertain`, never retried.
 */
import { describe, expect, it } from 'vitest';

import { classifyDispatchExit } from './dispatch.js';

const ok = { ok: true as const };
const vendor = (code: string, status?: number) => ({
  ok: false as const,
  error: { code, message: 'vendor failure', ...(status === undefined ? {} : { status }) },
});

describe('dispatch outcome classification', () => {
  it('a successful business result is observed', () => {
    const outcome = classifyDispatchExit('inv-1', {
      ok: true,
      value: { ok: true, data: { id: 7 } },
    });
    expect(outcome).toMatchObject({ kind: 'observed', code: 'ok', result: { id: 7 } });
  });

  it('a raw non-envelope result is still observed', () => {
    const outcome = classifyDispatchExit('inv-2', { ok: true, value: { id: 8 } });
    expect(outcome).toMatchObject({ kind: 'observed', code: 'ok', result: { id: 8 } });
  });

  it('an auth-wall vendor result with a 4xx status is observed', () => {
    const outcome = classifyDispatchExit('inv-3', {
      ok: true,
      value: vendor('connection_rejected', 401),
    });
    expect(outcome).toMatchObject({
      kind: 'observed',
      code: 'vendor_error',
      vendorErrorCode: 'connection_rejected',
    });
  });

  it('a protocol-level tool error without status is observed', () => {
    const outcome = classifyDispatchExit('inv-4', { ok: true, value: vendor('mcp_tool_error') });
    expect(outcome).toMatchObject({ kind: 'observed', vendorErrorCode: 'mcp_tool_error' });
  });

  it('a 5xx vendor result is uncertain (the write may have landed)', () => {
    const outcome = classifyDispatchExit('inv-5', {
      ok: true,
      value: vendor('upstream_error', 503),
    });
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'upstream_failure' });
  });

  it('upstream_unreachable is uncertain, not a failure', () => {
    const outcome = classifyDispatchExit('inv-6', {
      ok: true,
      value: vendor('upstream_unreachable'),
    });
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'transport_failure' });
  });

  it('an unknown no-status vendor code is uncertain (fail closed)', () => {
    const outcome = classifyDispatchExit('inv-7', { ok: true, value: vendor('some_new_code') });
    expect(outcome.kind).toBe('uncertain');
  });

  it('dispatch timeout, interrupt and failure are uncertain', () => {
    expect(
      classifyDispatchExit('inv-8', { ok: false, outcome: 'timeout', tag: 'TimeoutError' }),
    ).toMatchObject({
      kind: 'uncertain',
      code: 'deadline_exceeded',
    });
    expect(
      classifyDispatchExit('inv-9', { ok: false, outcome: 'interrupted', tag: 'DispatchAborted' }),
    ).toMatchObject({
      kind: 'uncertain',
      code: 'interrupted',
    });
    expect(
      classifyDispatchExit('inv-10', { ok: false, outcome: 'failure', tag: 'ToolInvocationError' }),
    ).toMatchObject({
      kind: 'uncertain',
      code: 'transport_failure',
    });
  });

  it('vendor error text is never echoed into the outcome', () => {
    const outcome = classifyDispatchExit('inv-11', {
      ok: true,
      value: {
        ok: false,
        error: { code: 'upstream_unreachable', message: 'SECRET-ARGUMENT-VALUE' },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain('SECRET-ARGUMENT-VALUE');
  });

  it('the observed success envelope duck-types (`ok` discriminant)', () => {
    expect(ok.ok).toBe(true);
  });
});
