import type { LocalRunModelExecution } from './local-model-execution.js';
import {
  modelObject as obj,
  modelText as text,
  modelPosition as pos,
  modelPositive as positive,
  modelEnum as en,
  modelDate as date,
} from './local-model-validation.js';
export function isLocalModelRunQuery(
  v: unknown,
): v is { workspaceId: string; roomId: string; runId: string } {
  return (
    obj(v, ['workspaceId', 'roomId', 'runId']) &&
    ['workspaceId', 'roomId', 'runId'].every((k) => text(v[k], 128))
  );
}
function identity(v: unknown) {
  if (
    !obj(
      v,
      ['source', 'providerId', 'modelId'],
      ['connectionId', 'connectionRevision', 'botProfileVersion', 'kind'],
    ) ||
    !text(v['providerId'], 64) ||
    !text(v['modelId'])
  )
    return false;
  return v['source'] === 'host'
    ? obj(v, ['source', 'providerId', 'modelId'])
    : v['source'] === 'connection' &&
        obj(v, [
          'source',
          'providerId',
          'modelId',
          'connectionId',
          'connectionRevision',
          'botProfileVersion',
          'kind',
        ]) &&
        text(v['connectionId']) &&
        pos(v['connectionRevision']) &&
        positive(v['botProfileVersion']) &&
        en(v['kind'], ['cloud', 'local']);
}
function completion(v: unknown) {
  return (
    obj(v, ['kind'], ['stopReason']) &&
    (v['kind'] === 'terminal'
      ? obj(v, ['kind', 'stopReason']) &&
        en(v['stopReason'], [
          'stop',
          'length',
          'content_filter',
          'tool_calls',
          'cancelled',
          'unknown',
        ])
      : obj(v, ['kind']) && en(v['kind'], ['rejected', 'not_sent', 'unknown']))
  );
}
function evidence(v: unknown) {
  if (!obj(v, ['kind'], ['tokens', 'estimator', 'reason'])) return false;
  if (v['kind'] === 'unavailable')
    return (
      obj(v, ['kind', 'reason']) && en(v['reason'], ['unsupported', 'not_reported', 'interrupted'])
    );
  if (
    !(v['kind'] === 'actual'
      ? obj(v, ['kind', 'tokens'])
      : v['kind'] === 'estimated' &&
        obj(v, ['kind', 'tokens', 'estimator']) &&
        text(v['estimator']))
  )
    return false;
  const t = v['tokens'];
  return (
    obj(t, ['inputTokens', 'outputTokens', 'totalTokens']) &&
    pos(t['inputTokens']) &&
    pos(t['outputTokens']) &&
    pos(t['totalTokens'])
  );
}
function projection(v: unknown) {
  if (
    !obj(v, ['identity', 'startedRequests', 'lastRequest', 'usage']) ||
    !identity(v['identity']) ||
    !positive(v['startedRequests'])
  )
    return false;
  const last = v['lastRequest'];
  const u = v['usage'];
  if (
    !obj(last, ['attemptId', 'ordinal', 'startedAt', 'settlement']) ||
    !text(last['attemptId'], 128) ||
    !positive(last['ordinal']) ||
    last['ordinal'] > v['startedRequests'] ||
    !date(last['startedAt'])
  )
    return false;
  const s = last['settlement'];
  if (
    s !== null &&
    !(
      obj(s, ['finishedAt', 'completion', 'usage']) &&
      date(s['finishedAt']) &&
      completion(s['completion']) &&
      evidence(s['usage'])
    )
  )
    return false;
  if (
    !obj(u, [
      'scope',
      'knownTokensScope',
      'knownTokens',
      'estimatedTokens',
      'unavailableRequests',
      'requestCounts',
      'completeness',
    ]) ||
    u['scope'] !== 'recorded_model_requests' ||
    u['knownTokensScope'] !== 'run_ledger_including_legacy_prefix' ||
    !pos(u['knownTokens']) ||
    !pos(u['estimatedTokens']) ||
    !pos(u['unavailableRequests']) ||
    !en(u['completeness'], ['complete', 'incomplete', 'unknown'])
  )
    return false;
  const c = u['requestCounts'];
  if (c === null) return u['completeness'] === 'unknown';
  if (
    !obj(c, ['actual', 'estimated', 'unavailable', 'pending']) ||
    !Object.values(c).every(pos) ||
    Number(c['actual']) +
      Number(c['estimated']) +
      Number(c['unavailable']) +
      Number(c['pending']) !==
      v['startedRequests']
  )
    return false;
  return (
    u['completeness'] ===
    (c['estimated'] === 0 && c['unavailable'] === 0 && c['pending'] === 0
      ? 'complete'
      : 'incomplete')
  );
}
export const isLocalRunModelExecution = (v: unknown): v is LocalRunModelExecution =>
  obj(v, ['version', 'workspaceId', 'roomId', 'runId', 'runVersion', 'execution']) &&
  v['version'] === 1 &&
  ['workspaceId', 'roomId', 'runId'].every((k) => text(v[k], 128)) &&
  pos(v['runVersion']) &&
  (v['execution'] === null || projection(v['execution']));
