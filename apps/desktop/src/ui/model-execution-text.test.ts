import { expect, it } from 'vitest';
import { modelExecutionLines } from './model-execution-text.js';
import type { LocalRunModelExecution } from '../model-protocol.js';
const report = (): LocalRunModelExecution => ({
  version: 1,
  workspaceId: 'ws_ocean',
  roomId: 'r',
  runId: 'run',
  runVersion: 7,
  execution: {
    identity: {
      source: 'connection',
      providerId: 'p',
      modelId: 'm',
      connectionId: 'original',
      connectionRevision: 2,
      botProfileVersion: 3,
      kind: 'local',
    },
    startedRequests: 1,
    lastRequest: {
      attemptId: 'a',
      ordinal: 1,
      startedAt: '2026-11-04T00:00:00Z',
      settlement: {
        finishedAt: '2026-11-04T00:00:01Z',
        completion: { kind: 'unknown' },
        usage: { kind: 'actual', tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      },
    },
    usage: {
      scope: 'recorded_model_requests',
      knownTokensScope: 'run_ledger_including_legacy_prefix',
      knownTokens: 0,
      estimatedTokens: 0,
      unavailableRequests: 0,
      requestCounts: null,
      completeness: 'unknown',
    },
  },
});
it('keeps unrecorded execution and unknown counts distinct from actual zero', () => {
  expect(modelExecutionLines({ ...report(), execution: null }).join(' ')).toContain('не записаны');
  const lines = modelExecutionLines(report()).join(' ');
  expect(lines).toContain('actual: 0');
  expect(lines).toContain('число запросов неизвестно');
  expect(lines).toContain('original');
  expect(lines).toContain('профиль 3');
  expect(lines).toContain('unknown');
  expect(lines).toContain('включая прежнюю часть');
});
it('labels estimated zero, unavailable and pending evidence without promoting them to actual', () => {
  const r = report();
  if (!r.execution) throw Error('fixture');
  const estimated = {
    ...r,
    execution: {
      ...r.execution,
      lastRequest: {
        ...r.execution.lastRequest,
        settlement: {
          ...r.execution.lastRequest.settlement!,
          usage: {
            kind: 'estimated' as const,
            estimator: 'e',
            tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      },
    },
  };
  expect(modelExecutionLines(estimated).join(' ')).toContain('estimated: 0');
  expect(modelExecutionLines(estimated).join(' ')).not.toContain('actual: 0');
  expect(
    modelExecutionLines({
      ...r,
      execution: { ...r.execution, lastRequest: { ...r.execution.lastRequest, settlement: null } },
    }).join(' '),
  ).toContain('pending');
  expect(
    modelExecutionLines({
      ...r,
      execution: {
        ...r.execution,
        lastRequest: {
          ...r.execution.lastRequest,
          settlement: {
            ...r.execution.lastRequest.settlement!,
            usage: { kind: 'unavailable', reason: 'interrupted' },
          },
        },
      },
    }).join(' '),
  ).toContain('unavailable');
});
