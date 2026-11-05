import { expect, it } from 'vitest';
import { unknownOutcome, settingsError, connectionCheckLine } from './model-settings-text.js';
it('uses settings-specific unknown-outcome guidance for transport loss without revealing text', () => {
  for (const code of ['connection_closed', 'runtime_timeout', 'runtime_unreachable']) {
    expect(unknownOutcome(Error(code))).toBe(true);
    expect(settingsError(Error(code))).toContain('исходную операцию');
  }
  expect(settingsError(Error('arbitrary synthetic key text'))).not.toContain('synthetic');
});
it('labels the actual checked revision and nonpersisted evidence after a local revision advance', () => {
  const line = connectionCheckLine(
    {
      status: {
        connectionId: 'a',
        providerId: 'ollama',
        kind: 'local',
        endpoint: 'http://127.0.0.1:11434',
        auth: 'none',
        defaultModelId: 'm',
        source: 'auth_none',
        state: 'connected',
        models: [],
        revision: 3,
        savedKey: false,
        writable: true,
        code: null,
        lastCheck: null,
      },
      check: {
        connectionId: 'a',
        outcome: 'ok',
        httpStatus: 200,
        durationMs: 1,
        models: ['m'],
        modelSupported: true,
        source: 'auth_none',
        revision: 2,
        checkedAt: '2026-11-04T00:00:00Z',
        persisted: false,
      },
    },
    4,
  );
  expect(line).toContain('проверена версия 2');
  expect(line).toContain('устарела');
  expect(line).toContain('не сохранено');
  expect(line).toContain('версия 3');
});
