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
});
it('explains the masked key field without echoing a key', () => {
  expect(providerKeyHint('', false)).toContain('Введите ключ');
  expect(providerKeyHint('', true)).toContain('Оставьте поле пустым');
  expect(providerKeyHint('typed-value', false)).toContain('локальным runtime');
  expect(providerKeyHint('typed-value', true)).toContain('заменён');
  expect(providerKeyHint('typed-value', false)).not.toContain('typed-value');
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
