import { expect, it } from 'vitest';
import type { ProviderStatus } from '../protocol.js';
import {
  providerCapabilitySuffix,
  providerCheckLine,
  providerCheckText,
  providerKeyHint,
  providerSourceText,
  providerStateText,
  providerStatusLine,
  retiredModelHint,
} from './provider-text.js';

const status: ProviderStatus = {
  provider: 'deepseek',
  source: 'saved',
  state: 'connected',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  modelCapabilities: [
    { model: 'deepseek-flash', imageInput: true },
    { model: 'deepseek-v4-pro', imageInput: false },
  ],
  revision: 3,
  savedKey: true,
  writable: true,
  code: null,
  lastCheck: null,
};
it('renders a truthful status line without any credential material', () => {
  const line = providerStatusLine(status);
  expect(line).toBe('Подключено · Ключ Ocean · deepseek-flash · ревизия 3');
  expect(line).not.toContain('sk-');
  for (const code of Object.keys(providerStateText)) void code;
  for (const source of Object.keys(providerSourceText)) void source;
  expect(providerStatusLine({ ...status, state: 'disconnected', source: 'none' })).toBe(
    'Отключено · Не настроено · deepseek-flash · ревизия 3',
  );
  expect(providerStatusLine({ ...status, model: null, state: 'absent' })).toContain(
    'модель не выбрана',
  );
});
it('renders every normalized check outcome and never vendor text', () => {
  for (const outcome of Object.keys(providerCheckText)) {
    const line = providerCheckLine({
      outcome: outcome as keyof typeof providerCheckText,
      httpStatus: null,
      durationMs: 12,
      models: ['deepseek-flash'],
      modelSupported: true,
      source: 'saved',
      revision: 2,
      checkedAt: '2026-11-04T00:00:00.000Z',
    });
    expect(line).toContain('12 мс');
    expect(line).not.toContain('sk-');
  }
  expect(providerCheckLine(check())).toBe(
    'Проверка: Список моделей получен · 2 моделей · выбранная модель поддерживается · 9 мс',
  );
  expect(providerCheckLine({ ...check(), outcome: 'cancelled' })).toContain('отменена');
});
it('marks a persisted check as stale once the connection source or revision moved on', () => {
  const saved = check();
  const current = { revision: saved.revision, source: saved.source };
  expect(providerCheckLine(saved, current)).toBe(
    'Проверка: Список моделей получен · 2 моделей · выбранная модель поддерживается · 9 мс',
  );
  expect(providerCheckLine(saved, { revision: saved.revision + 1, source: 'saved' })).toContain(
    'устарела',
  );
  expect(providerCheckLine(saved, { revision: saved.revision, source: 'external' })).toContain(
    'устарела',
  );
});
it('maps an unknown or removed bot model to clearer visible text', () => {
  const retired = retiredModelHint('deepseek-chat', status.models);
  expect(retired).toContain('deepseek-chat');
  expect(retired).toContain('больше не');
  expect(retired).not.toContain('sk-');
  expect(retiredModelHint('deepseek-flash', status.models)).toBeNull();
  // An unloaded provider status must not guess a model problem.
  expect(retiredModelHint('deepseek-chat', [])).toBeNull();
  expect(retiredModelHint(null, status.models)).toBeNull();
});
it('explains the masked key field without echoing a key', () => {
  expect(providerKeyHint('', false)).toContain('Введите ключ');
  expect(providerKeyHint('', true)).toContain('Оставьте поле пустым');
  expect(providerKeyHint('typed-value', false)).toContain('локальным runtime');
  expect(providerKeyHint('typed-value', true)).toContain('заменён');
  expect(providerKeyHint('typed-value', false)).not.toContain('typed-value');
});
it('explains the unverified saved key without promising a model-only change', () => {
  const hint = providerKeyHint('', true, 'unverified');
  expect(hint).toContain('Введите ключ заново');
  expect(hint).not.toContain('Оставьте поле пустым');
  expect(providerKeyHint('', false, 'unverified')).toContain('Введите ключ API');
});
it('declares documented model capabilities honestly', () => {
  expect(providerCapabilitySuffix(true)).toContain('изображения');
  expect(providerCapabilitySuffix(false)).toContain('только текст');
});
function check() {
  return {
    outcome: 'ok' as const,
    httpStatus: 200,
    durationMs: 9,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelSupported: true,
    source: 'saved' as const,
    revision: 3,
    checkedAt: '2026-11-04T00:00:00.000Z',
    persisted: true,
  };
}
