import type { LocalRunModelExecution } from '../model-protocol.js';
/** Frozen run evidence only. No current binding or default-model substitution. */
export function modelExecutionLines(report: LocalRunModelExecution): string[] {
  const lines = [`Версия запуска: ${report.runVersion}`],
    execution = report.execution;
  if (!execution)
    return [...lines, 'Данные исполнения модели не записаны; использование неизвестно.'];
  const identity = execution.identity;
  lines.push(`${identity.providerId} / ${identity.modelId}`);
  if (identity.source === 'connection')
    lines.push(
      `${identity.connectionId} · ${identity.kind} · версия подключения ${identity.connectionRevision} · профиль ${identity.botProfileVersion}`,
    );
  else lines.push('Источник: host');
  const usage = execution.usage,
    counts = usage.requestCounts;
  lines.push(`Полнота использования: ${usage.completeness}; область: ${usage.scope}`);
  lines.push(
    counts
      ? `Запросы: actual ${counts.actual}, estimated ${counts.estimated}, unavailable ${counts.unavailable}, pending ${counts.pending}`
      : 'Запросы: число запросов неизвестно.',
  );
  lines.push(
    `Известные токены журнала запуска, включая прежнюю часть: ${usage.knownTokens}; оценка: ${usage.estimatedTokens}`,
  );
  const settlement = execution.lastRequest.settlement;
  if (!settlement)
    return [...lines, 'Последний запрос: pending; завершение и использование не записаны.'];
  lines.push(
    `Завершение последнего запроса: ${settlement.completion.kind}${settlement.completion.kind === 'terminal' ? ` / ${settlement.completion.stopReason}` : ''}`,
  );
  const evidence = settlement.usage;
  lines.push(
    evidence.kind === 'unavailable'
      ? `Последнее использование: unavailable / ${evidence.reason}`
      : `Последнее использование: ${evidence.kind}: ${evidence.tokens.totalTokens} токенов${evidence.kind === 'estimated' ? ` / ${evidence.estimator}` : ''}`,
  );
  return lines;
}
