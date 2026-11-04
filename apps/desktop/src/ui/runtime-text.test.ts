import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Run } from '../protocol.js';
import { feedbackText, historyState, runText, turnText } from './runtime-text.js';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
it('suppresses only runtime_absent feedback while the welcome screen is shown', () => {
  expect(feedbackText('Runtime не запущен', 'runtime_absent', true)).toBe('');
  expect(feedbackText('Runtime не запущен', 'runtime_absent', false)).toBe('Runtime не запущен');
  for (const code of ['profile_missing', 'insecure_permissions', 'outcome_unknown']) {
    expect(feedbackText('Другая ошибка', code, true)).toBe('Другая ошибка');
  }
  expect(feedbackText('Готово', '', true)).toBe('Готово');
  expect(source('./Desktop.vue')).toContain(':feedback="feedback"');
  expect(source('./state.ts')).toContain(
    'feedbackText(feedback.value, feedbackCode.value, !room.value)',
  );
});
it('translates every turn status without exposing run metadata', () => {
  const expected = {
    queued: 'В очереди рассылки',
    accepted: 'Запрос принят',
    dispatching: 'Готовим ответ…',
    prepared: '@review отвечает…',
    completed: '@review ответил',
    failed: 'Не удалось получить ответ',
    uncertain: 'Исход ответа не подтверждён',
    cancelled: 'Остановлено',
  };
  for (const turnStatus of Object.keys(turnText) as Run['turnStatus'][]) {
    const text = runText({ turnStatus, runId: 'tr_9c1d', version: 42 } as Run, 'review');
    expect(text).toBe(expected[turnStatus]);
    expect(text).not.toMatch(/tr_9c1d|v42/);
  }
});
it('distinguishes failed history from an empty room, including stale messages', () => {
  expect(historyState('Ошибка чтения', 0, false)).toBe('error');
  expect(historyState('Ошибка чтения', 3, false)).toBe('error');
  expect(historyState('', 0, false)).toBe('empty');
  expect(historyState('', 0, true)).toBe('messages');
  const template = source('./RoomHistory.vue');
  expect(template).toContain("historyState(readError, history.length, busy) === 'error'");
  expect(template).toContain("historyState(readError, history.length, busy) === 'empty'");
  expect(template).toContain('Не удалось загрузить историю');
  expect(template).toContain('@click="$emit(\'refresh\')"');
});
it('keeps technical metadata out of cancellation labels and separates alerts from status', () => {
  const composer = source('./RoomComposer.vue');
  expect(composer).not.toMatch(/active\.(runId|version)/);
  expect(composer).toContain('Остановить ответ @');
  expect(composer).toContain('v-if="sending" role="status"');
  const feedback = source('./RuntimeFeedback.vue');
  expect(feedback).toContain('role="alert" class="runtime-error"');
  expect(feedback).toContain('role="status"');
  expect(feedback).toContain(':title="receipt"');
});
